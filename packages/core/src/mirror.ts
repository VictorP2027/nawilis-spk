import { collections, getDb } from './mongo.js';
import type { MirrorView } from './validation.js';
import type { SpkDoc, TbServiceProduct } from './types.js';

const STALE_MS = 24 * 3600 * 1000; // service-product mirror older than this ⇒ WARN not BLOCK

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Load the Turboly master-data mirror needed to validate + build a push payload
 * for one branch. The mirror is refreshed by seed/turboly-import.ts from the
 * tenant export — absence here means "not known", never "does not exist".
 */
export async function loadMirror(branchCode: string, opts: { withProductSkus?: boolean } = {}): Promise<MirrorView & { skuFor: (serviceCode: string) => string | null }> {
  const [store, products, mechanics, skuMaps, productIds] = await Promise.all([
    collections.tbStores().findOne({ _id: branchCode }),
    collections.tbServiceProducts().find({ $or: [{ storeCode: branchCode }, { storeCode: null }] }).toArray(),
    collections.tbMechanics().find({ $or: [{ storeCode: branchCode }, { storeCode: null }] }).toArray(),
    collections.serviceSkuMap().find({ $or: [{ branchCode }, { branchCode: null }] }).toArray(),
    /**
     * Every SKU Turboly sells as GOODS, ids only (~4k strings) — and ONLY when the
     * caller asks. The intake path runs loadMirror on every submission with an
     * operator waiting, and it has no use for this; the pusher does.
     *
     * A prefix rule cannot answer this: AKS- appears in tb_products AND in
     * service_options, and those seven "service" entries are precisely the
     * miscategorisation that sent AKS-NAW-PEKA to a service line where Turboly
     * has no such service. Membership in the scraped product catalogue is the
     * only test that is actually true.
     */
    opts.withProductSkus ? getDb().collection('tb_products').distinct('_id') : Promise.resolve([]),
  ]);

  const serviceProducts = new Map<string, TbServiceProduct>();
  let newestSync = 0;
  for (const p of products) {
    serviceProducts.set(p.sku, p);
    const t = Date.parse(p.syncedAt);
    if (Number.isFinite(t)) newestSync = Math.max(newestSync, t);
  }

  const advisorByName = new Map<string, (typeof mechanics)[number]>();
  const salespersonByName = new Map<string, (typeof mechanics)[number]>();
  for (const m of mechanics) {
    advisorByName.set(norm(m.name), m);
    salespersonByName.set(norm(m.name), m);
  }

  // Prefer branch-specific + confirmed SKU maps over tenant-wide / unconfirmed.
  const skuByCode = new Map<string, { sku: string; confirmed: boolean; branchSpecific: boolean }>();
  for (const map of skuMaps) {
    const branchSpecific = map.branchCode === branchCode;
    const existing = skuByCode.get(map.serviceCode);
    const better =
      !existing ||
      (branchSpecific && !existing.branchSpecific) ||
      (branchSpecific === existing.branchSpecific && map.confirmed && !existing.confirmed);
    if (better) skuByCode.set(map.serviceCode, { sku: map.sku, confirmed: map.confirmed, branchSpecific });
  }

  const serviceProductsStale = newestSync === 0 || Date.now() - newestSync > STALE_MS;

  return {
    store: store ?? null,
    serviceProducts,
    advisorByName,
    salespersonByName,
    serviceProductsStale,
    productSkus: new Set((productIds as unknown[]).map((id) => String(id))),
    skuFor: (serviceCode: string) => skuByCode.get(serviceCode)?.sku ?? null,
  };
}

/**
 * Resolve turbolySku for each ordered job line from the mirror, updating the
 * unmapped count. Run this at validation time so Layer 2 can check SKU existence.
 */
export function resolveSkus(doc: SpkDoc, skuFor: (serviceCode: string) => string | null): SpkDoc {
  const jobLines = doc.jobLines.map((l) => (l.ordered && !l.turbolySku ? { ...l, turbolySku: skuFor(l.serviceCode) } : l));
  const unmappedCount = jobLines.filter((l) => l.ordered && !l.turbolySku).length;
  return { ...doc, jobLines, jobLineSummary: { ...doc.jobLineSummary, unmappedCount } };
}
