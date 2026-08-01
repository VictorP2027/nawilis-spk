import type { SpkDoc, TbStore, TbServiceProduct, TbMechanic } from '../types.js';
import type { TurbolyServiceOrderPayload } from './sink.js';
import { REF_SERVICES } from '../refdata.js';

export interface ResolveInput {
  doc: SpkDoc;
  store: TbStore;
  serviceProducts: Map<string, TbServiceProduct>; // sku -> product
  serviceAdvisor: TbMechanic;
  salesperson: TbMechanic;
  /** Plan service date/time; default to arrival day/now if not scheduled. */
  planServiceDate?: string;
  planServiceTime?: string;
}

/** Format an ISO instant as YYYY-MM-DD in WIB (Turboly's #service-date field format). */
export function formatDateWib(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

export function formatTimeWib(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * A guaranteed-future plan date/time in WIB, derived from the real clock.
 * Turboly rejects a Service Order whose Plan Service Time is not greater than
 * the current server time, so a walk-in SPK (plan == "now") must be nudged
 * forward by a small buffer. Date + time come from the same instant so they
 * stay consistent across a midnight rollover. This is impure by design — the
 * caller (the worker) owns the side effect; buildTurbolyPayload stays pure.
 */
export function planFromNowWib(bufferMinutes = 30): { date: string; time: string } {
  const iso = new Date(Date.now() + bufferMinutes * 60 * 1000).toISOString();
  return { date: formatDateWib(iso), time: formatTimeWib(iso) };
}

/**
 * Build the fully-resolved Turboly payload. Throws if a required mapping is
 * missing — the caller must have passed Layer-2 validation first, so a throw
 * here is a programming error, not a data error.
 */
export function buildTurbolyPayload(input: ResolveInput): TurbolyServiceOrderPayload {
  const { doc, store, serviceProducts } = input;
  const planDate = input.planServiceDate ?? formatDateWib(doc.capture.arrivalTime);
  const planTime = input.planServiceTime ?? formatTimeWib(doc.capture.arrivalTime);

  const ordered = doc.jobLines.filter((l) => l.ordered && l.turbolySku);

  const serviceLines: TurbolyServiceOrderPayload['serviceLines'] = [];
  const sparepartLines: TurbolyServiceOrderPayload['sparepartLines'] = [];

  for (const line of ordered) {
    const sku = line.turbolySku!;
    const product = serviceProducts.get(sku);
    const serviceName = product?.name ?? sku;
    const section = REF_SERVICES.find((s) => s.code === line.serviceCode)?.turbolySection ?? 'service';
    if (section === 'sparepart') {
      sparepartLines.push({ productName: serviceName, qty: line.qty, priceIncTax: line.quotedPrice, expectedSku: sku });
    } else {
      serviceLines.push({
        serviceName,
        description: line.keterangan ?? '',
        qty: line.qty,
        priceIncTax: line.quotedPrice,
        discount: null,
        expectedSku: sku,
      });
    }
  }

  const customerExisting = doc.customer.turbolyCustomerId
    ? doc.customer.turbolyCustomerId
    : doc.customer.waE164
      ? doc.customer.waE164
      : doc.customer.nama || null;

  return {
    spkId: doc._id,
    correlationToken: doc.push.correlationToken,
    storeName: store.turbolyStoreName,
    storeTurbolyId: store.turbolyStoreId,
    type: 'General',
    // existingQuery is tried first; `create` is ALWAYS provided so the sink can
    // fall back to creating a new customer+vehicle when the search finds nothing.
    customer: {
      existingQuery: customerExisting,
      create: { nama: doc.customer.nama, phone: doc.customer.waE164 ?? '', alamat: doc.customer.alamat ?? '' },
    },
    vehicleRegistration: doc.vehicle.noPolisi.display,
    vehiclePlateFull: doc.vehicle.noPolisi.full,
    // trim: a stray trailing space hangs Turboly's remote make/model search
    vehicleMake: (doc.vehicle.merkNormalized ?? doc.vehicle.merkRaw ?? '').trim(),
    vehicleModel: (doc.vehicle.tipeNormalized ?? '').trim(),
    vehicleYear: doc.vehicle.tahun != null ? String(doc.vehicle.tahun) : '',
    vehicleColor: (doc.vehicle.warna ?? '').trim(),
    odometer: String(doc.vehicle.km.value),
    planServiceDate: planDate,
    planServiceTime: planTime,
    serviceAdvisorName: input.serviceAdvisor.name,
    salespersonName: input.salesperson.name,
    referenceNumber: doc.push.correlationToken,
    notes: buildNotes(doc),
    serviceLines,
    sparepartLines,
  };
}

/**
 * The notes-field absorbs every SPK field that has no home in Turboly, in a
 * fixed priority order. Keep it deterministic so read-back can reason about it.
 */
function buildNotes(doc: SpkDoc): string {
  const parts: string[] = [];
  if (doc.complaint.keluhan) parts.push(`Keluhan: ${doc.complaint.keluhan}`);
  const custom = doc.jobLines.filter((l) => l.ordered && !l.turbolySku).map((l) => l.serviceCode);
  if (custom.length) parts.push(`Pekerjaan lain: ${custom.join(', ')}`);
  const issues = doc.conditionChecks.filter((c) => c.status === 'ISSUE').map((c) => `${c.item}(${c.marks.join('/')})`);
  if (issues.length) parts.push(`Kondisi: ${issues.join('; ')}`);
  if (doc.rekomendasiService?.text) parts.push(`Rekomendasi: ${doc.rekomendasiService.text}`);
  if (doc.vehicle.tahun) parts.push(`Tahun: ${doc.vehicle.tahun}`);
  if (doc.vehicle.warna) parts.push(`Warna: ${doc.vehicle.warna}`);
  if (doc.customer.kontakLain) parts.push(`Kontak lain: ${doc.customer.kontakLain}`);
  parts.push(`[${doc.push.correlationToken}]`);
  return parts.join('\n');
}
