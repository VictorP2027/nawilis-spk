import type { SpkDoc } from '../types.js';

/**
 * The fully-resolved, Turboly-facing payload. The worker builds this from an
 * SpkDoc + the tb_* mirror, so the sink is purely mechanical DOM-driving and
 * has no business logic. Every string here is exactly what gets typed.
 */
export interface TurbolyServiceOrderPayload {
  spkId: string;
  correlationToken: string;
  storeName: string;
  storeTurbolyId: string; // numeric option value for <select id="store-id">, e.g. "8339"
  type: string; // default "General"
  customer: { existingQuery: string | null; create: { nama: string; phone: string; alamat: string } | null };
  vehicleRegistration: string; // display plate, matching Turboly spacing
  /** No-space plate for the create-vehicle form + search, e.g. "B1234SZA". */
  vehiclePlateFull?: string;
  /** Details for creating a brand-new vehicle when it isn't already in Turboly. */
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: string;
  vehicleColor?: string;
  odometer: string;
  planServiceDate: string; // formatted for the date field, e.g. "31-07-2026"
  planServiceTime: string; // e.g. "09:30"
  serviceAdvisorName: string;
  salespersonName: string;
  referenceNumber: string; // == correlationToken
  notes: string;
  serviceLines: Array<{ serviceName: string; description: string; qty: number; priceIncTax: number | null; discount: number | null; expectedSku: string }>;
  sparepartLines: Array<{ productName: string; qty: number; priceIncTax: number | null; expectedSku: string }>;
}

/**
 * ServiceOrderSink — the swappable ingress contract.
 *
 * The whole system is built so the ingress mechanism is ONE class:
 *   - RpaSink     (W2) drives the real Turboly web UI via Playwright.
 *   - ApiSink     (W1) calls a Turboly API/CSV import, if one is ever granted.
 *   - ManualSink  (W3) records that a human must enter it, and stores the doc no.
 *
 * The worker never knows which is active. Swapping worlds = swapping the sink.
 */

export interface PushContext {
  /** Worker identity + fencing epoch — re-asserted before every irreversible click. */
  workerId: string;
  epoch: number;
  /** Whether to advance the SO from DRAFT → APPROVED after saving. */
  approve: boolean;
  /** Abort if the lease is about to expire (ms since epoch). */
  leaseExpiresAt: number;
}

export interface PushResult {
  ok: boolean;
  /** Turboly's generated Service Order document number, captured on save. */
  serviceOrderNo: string | null;
  workOrderNo: string | null;
  /** Absolute URL of the created SO detail page (for direct, independent read-back). */
  serviceOrderUrl?: string | null;
  /** What the read-back verified against. */
  verified: {
    matchedOn: string[];
    lineCount: number | null;
    lineSkus: string[];
    km: number | null;
    store: string | null;
  } | null;
  failureClass?: 'transient' | 'auth' | 'data' | 'structural' | 'infra';
  error?: string;
  /** Evidence: path to a screenshot taken at submit. */
  screenshotRef?: string | null;
}

export interface VerifyResult {
  found: boolean;
  serviceOrderNo: string | null;
  store: string | null;
  lineCount: number | null;
  lineSkus: string[];
  km: number | null;
}

export interface ServiceOrderSink {
  readonly mode: 'rpa' | 'api' | 'manual';
  /** Create (and optionally approve) the Service Order from a resolved payload. */
  pushServiceOrder(payload: TurbolyServiceOrderPayload, ctx: PushContext): Promise<PushResult>;
  /**
   * Independent read-back by correlation token — MUST run in a fresh context,
   * never reusing the write session. Sets `confirmed`, nothing else may.
   */
  verifyByToken(doc: SpkDoc): Promise<VerifyResult>;
  /** Structural canary: does the SO form still look the way we expect? */
  canary(): Promise<{ ok: boolean; controlHash: string; detail?: string }>;
  dispose?(): Promise<void>;
}
