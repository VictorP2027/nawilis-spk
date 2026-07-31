import type { ServiceOrderSink, PushContext, PushResult, VerifyResult, TurbolyServiceOrderPayload } from './sink.js';
import type { SpkDoc } from '../types.js';

/**
 * W1 — the clean path. If Turboly ever grants an API (their 2019 changelog and
 * 2018 PrestaShop plugin show a `/api/public/v1` sales namespace exists; a
 * service endpoint would slot in here), this becomes the whole ingress and the
 * entire RPA fleet + canary + degradation ladder can be deleted.
 *
 * Left as a typed stub so switching worlds is a one-line factory change.
 */
export interface ApiConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
  createServiceOrderPath: string; // e.g. /api/public/v1/service_orders (UNCONFIRMED)
}

export class ApiSink implements ServiceOrderSink {
  readonly mode = 'api' as const;
  constructor(private readonly cfg: ApiConfig) {}

  async pushServiceOrder(payload: TurbolyServiceOrderPayload, _ctx: PushContext): Promise<PushResult> {
    const token = await this.cfg.getToken();
    const res = await fetch(new URL(this.cfg.createServiceOrderPath, this.cfg.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(mapPayloadToApi(payload)),
    });
    if (res.status === 401 || res.status === 403) return failApi('auth', `HTTP ${res.status}`);
    if (res.status >= 500) return failApi('infra', `HTTP ${res.status}`);
    if (!res.ok) return failApi('data', `HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const body = (await res.json().catch(() => ({}))) as { document_number?: string };
    return {
      ok: true,
      serviceOrderNo: body.document_number ?? null,
      workOrderNo: null,
      verified: { matchedOn: ['api_response'], lineCount: payload.serviceLines.length, lineSkus: payload.serviceLines.map((l) => l.expectedSku), km: Number(payload.odometer) || null, store: payload.storeName },
    };
  }

  async verifyByToken(doc: SpkDoc): Promise<VerifyResult> {
    const token = await this.cfg.getToken();
    const res = await fetch(new URL(`${this.cfg.createServiceOrderPath}?reference=${encodeURIComponent(doc.push.correlationToken)}`, this.cfg.baseUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { found: false, serviceOrderNo: null, store: null, lineCount: null, lineSkus: [], km: null };
    const list = (await res.json().catch(() => [])) as Array<{ document_number: string; store: string; lines: string[]; odometer: number }>;
    const hit = list[0];
    if (!hit) return { found: false, serviceOrderNo: null, store: null, lineCount: null, lineSkus: [], km: null };
    return { found: true, serviceOrderNo: hit.document_number, store: hit.store, lineCount: hit.lines?.length ?? null, lineSkus: hit.lines ?? [], km: hit.odometer ?? null };
  }

  async canary(): Promise<{ ok: boolean; controlHash: string }> {
    // For an API, the canary is a schema/health probe rather than a DOM hash.
    try {
      await this.cfg.getToken();
      return { ok: true, controlHash: 'api' };
    } catch (e) {
      return { ok: false, controlHash: '', ...(e ? {} : {}) };
    }
  }
}

function mapPayloadToApi(p: TurbolyServiceOrderPayload): Record<string, unknown> {
  return {
    store: p.storeName,
    reference_number: p.referenceNumber,
    customer: p.customer.existingQuery ?? p.customer.create,
    registration: p.vehicleRegistration,
    odometer: Number(p.odometer) || 0,
    plan_service_date: p.planServiceDate,
    plan_service_time: p.planServiceTime,
    service_advisor: p.serviceAdvisorName,
    salesperson: p.salespersonName,
    notes: p.notes,
    services: p.serviceLines.map((l) => ({ sku: l.expectedSku, qty: l.qty, price_inc_tax: l.priceIncTax, discount: l.discount, description: l.description })),
    spareparts: p.sparepartLines.map((l) => ({ sku: l.expectedSku, qty: l.qty, price_inc_tax: l.priceIncTax })),
  };
}

function failApi(failureClass: NonNullable<PushResult['failureClass']>, error: string): PushResult {
  return { ok: false, serviceOrderNo: null, workOrderNo: null, verified: null, failureClass, error };
}
