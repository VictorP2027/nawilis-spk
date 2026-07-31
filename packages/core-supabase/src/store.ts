import {
  canTransition, IllegalTransitionError, isUsedInServiceOrder, newSpkId,
  type SpkDoc, type SpkEvent, type VehicleDoc, type TbStore, type TbServiceProduct,
  type TbMechanic, type PipelineState, type MirrorView,
} from '@spk/core';
import { sb } from './client.js';

/** Columns promoted out of the JSONB doc for indexing + CAS. */
function promoted(doc: SpkDoc): Record<string, unknown> {
  return {
    upload_id: doc.uploadId ?? null,
    branch_code: doc.branchCode,
    state: doc.state,
    nomor_antrian: doc.nomorAntrian ?? null,
    plate: doc.vehicle?.noPolisi?.full ?? null,
    business_date: doc.capture?.businessDate ?? null,
    used: isUsedInServiceOrder(doc),
    doc,
    updated_at: new Date().toISOString(),
  };
}

export async function insertSpk(doc: SpkDoc): Promise<void> {
  const { error } = await sb().from('spk').insert({ id: doc._id, created_at: doc.createdAt, ...promoted(doc) });
  if (error) throw error;
}

export async function getSpk(id: string): Promise<SpkDoc | null> {
  const { data, error } = await sb().from('spk').select('doc').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data?.doc as SpkDoc) ?? null;
}

export async function getByUploadId(uploadId: string): Promise<SpkDoc | null> {
  const { data } = await sb().from('spk').select('doc').eq('upload_id', uploadId).maybeSingle();
  return (data?.doc as SpkDoc) ?? null;
}

/**
 * Compare-and-swap transition — the concurrency-safety primitive. The UPDATE's
 * `.eq('state', from)` means only one worker can advance a given row; the loser
 * matches 0 rows and gets null. Postgres serialises the concurrent updates.
 */
export async function transition(
  id: string,
  from: PipelineState,
  to: PipelineState,
  patch: Partial<SpkDoc> = {},
): Promise<SpkDoc | null> {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  const cur = await getSpk(id);
  if (!cur) return null;
  const merged: SpkDoc = { ...cur, ...patch, state: to, updatedAt: new Date().toISOString() };
  const { data, error } = await sb()
    .from('spk')
    .update({ ...promoted(merged), state: to })
    .eq('id', id)
    .eq('state', from)
    .select('doc');
  if (error) throw error;
  return (data?.[0]?.doc as SpkDoc) ?? null;
}

export async function emit(evt: Omit<SpkEvent, '_id' | 'at'> & { at?: string }): Promise<void> {
  await sb().from('spk_events').insert({ id: newSpkId(), spk_id: evt.spkId, at: evt.at ?? new Date().toISOString(), type: evt.type, by: evt.by, data: evt.data ?? null });
}

export async function listSpk(filter: { branch?: string | null; state?: string | null; plate?: string | null; used?: boolean }): Promise<SpkDoc[]> {
  let q = sb().from('spk').select('doc').order('created_at', { ascending: false }).limit(200);
  if (filter.branch) q = q.eq('branch_code', filter.branch);
  if (filter.state) q = q.eq('state', filter.state);
  if (filter.plate) q = q.eq('plate', filter.plate.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (filter.used !== undefined) q = q.eq('used', filter.used);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((d) => d.doc as SpkDoc);
}

/** Rows for the Nawilis xlsx export. scope=used → only mechanic-assigned SPKs. */
export async function exportRows(filter: { outlet?: string | null; from?: string | null; to?: string | null; used: boolean }): Promise<SpkDoc[]> {
  let q = sb().from('spk').select('doc').order('created_at', { ascending: true }).limit(10000);
  if (filter.outlet) q = q.eq('branch_code', filter.outlet);
  if (filter.from) q = q.gte('business_date', filter.from);
  if (filter.to) q = q.lte('business_date', filter.to);
  if (filter.used) q = q.eq('used', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((d) => d.doc as SpkDoc);
}

export async function deleteSpk(id: string): Promise<number> {
  await sb().from('spk_events').delete().eq('spk_id', id);
  await sb().from('turboly_docs').delete().eq('spk_id', id);
  const { count } = await sb().from('spk').delete({ count: 'exact' }).eq('id', id);
  return count ?? 0;
}

export async function findVehicleByVariants(variants: string[]): Promise<VehicleDoc | null> {
  if (!variants.length) return null;
  const { data } = await sb().from('vehicles').select('doc').overlaps('plate_variants', variants).limit(1).maybeSingle();
  return (data?.doc as VehicleDoc) ?? null;
}

export async function upsertVehicle(doc: SpkDoc): Promise<void> {
  if (!doc.vehicle.noPolisi.full) return;
  const id = `veh_${doc.vehicle.noPolisi.full}`;
  const existing = await sb().from('vehicles').select('doc,plate_variants').eq('id', id).maybeSingle();
  const prior = (existing.data?.doc as VehicleDoc) ?? null;
  const mergedVariants = Array.from(new Set([...(existing.data?.plate_variants ?? []), ...doc.vehicle.plateVariants]));
  const vdoc: VehicleDoc = {
    _id: id,
    plateFull: doc.vehicle.noPolisi.full,
    plateVariants: mergedVariants,
    merk: doc.vehicle.merkNormalized,
    tipe: doc.vehicle.tipeNormalized,
    tahun: doc.vehicle.tahun,
    warna: doc.vehicle.warna,
    lastKm: doc.vehicle.km.value,
    lastSeenAt: doc.capture.receivedAt,
    lastBranch: doc.branchCode,
    visitCount: (prior?.visitCount ?? 0) + 1,
    customerRefs: prior?.customerRefs ?? [],
  };
  await sb().from('vehicles').upsert({ id, plate_full: vdoc.plateFull, plate_variants: mergedVariants, doc: vdoc });
}

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');
const STALE_MS = 24 * 3600 * 1000;

/** Build the Turboly mirror view for a branch (same shape as @spk/core). */
export async function loadMirror(branchCode: string): Promise<MirrorView & { skuFor: (serviceCode: string) => string | null }> {
  const [storeR, prodR, mechR, mapR] = await Promise.all([
    sb().from('tb_stores').select('doc').eq('branch_code', branchCode).maybeSingle(),
    sb().from('tb_service_products').select('doc,store_code').or(`store_code.is.null,store_code.eq.${branchCode}`),
    sb().from('tb_mechanics').select('doc,store_code').or(`store_code.is.null,store_code.eq.${branchCode}`),
    sb().from('service_sku_map').select('*').or(`branch_code.is.null,branch_code.eq.${branchCode}`),
  ]);

  const serviceProducts = new Map<string, TbServiceProduct>();
  let newest = 0;
  for (const r of prodR.data ?? []) {
    const p = r.doc as TbServiceProduct;
    serviceProducts.set(p.sku, p);
    const t = Date.parse(p.syncedAt);
    if (Number.isFinite(t)) newest = Math.max(newest, t);
  }
  const advisorByName = new Map<string, TbMechanic>();
  const salespersonByName = new Map<string, TbMechanic>();
  for (const r of mechR.data ?? []) {
    const m = r.doc as TbMechanic;
    advisorByName.set(norm(m.name), m);
    salespersonByName.set(norm(m.name), m);
  }
  const skuByCode = new Map<string, { sku: string; confirmed: boolean; branchSpecific: boolean }>();
  for (const m of mapR.data ?? []) {
    const branchSpecific = m.branch_code === branchCode;
    const cur = skuByCode.get(m.service_code);
    const better = !cur || (branchSpecific && !cur.branchSpecific) || (branchSpecific === cur.branchSpecific && m.confirmed && !cur.confirmed);
    if (better) skuByCode.set(m.service_code, { sku: m.sku, confirmed: m.confirmed, branchSpecific });
  }

  return {
    store: (storeR.data?.doc as TbStore) ?? null,
    serviceProducts,
    advisorByName,
    salespersonByName,
    serviceProductsStale: newest === 0 || Date.now() - newest > STALE_MS,
    skuFor: (code: string) => skuByCode.get(code)?.sku ?? null,
  };
}

/** Dashboard summary: counts by state + by branch, plus the degradation rung. */
export async function summarize(): Promise<{
  byState: Record<string, number>;
  byBranch: Array<{ _id: string; captured: number; confirmed: number }>;
  dlqOpen: number;
  degradation: { rung: number };
  lastRecon: null;
  ageAlerts: { queuedStale: number; pushingStale: number; reviewStale: number; manualStale: number };
}> {
  const { data } = await sb().from('spk').select('state,branch_code').limit(5000);
  const rows = data ?? [];
  const byState: Record<string, number> = {};
  const branchMap = new Map<string, { _id: string; captured: number; confirmed: number }>();
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    const b = branchMap.get(r.branch_code) ?? { _id: r.branch_code, captured: 0, confirmed: 0 };
    b.captured++;
    if (r.state === 'confirmed') b.confirmed++;
    branchMap.set(r.branch_code, b);
  }
  const deg = await sb().from('degradation_state').select('doc').eq('id', 'degradation').maybeSingle();
  return {
    byState,
    byBranch: [...branchMap.values()].sort((a, b) => a._id.localeCompare(b._id)),
    dlqOpen: 0,
    degradation: { rung: (deg.data?.doc as { rung?: number })?.rung ?? 0 },
    lastRecon: null,
    ageAlerts: { queuedStale: 0, pushingStale: 0, reviewStale: 0, manualStale: 0 },
  };
}

/** Daily per-outlet queue number YYYYMMDD + sequence. */
export async function nextQueueNumber(branchCode: string, businessDate: string): Promise<string> {
  const { count } = await sb().from('spk').select('id', { count: 'exact', head: true }).eq('branch_code', branchCode).eq('business_date', businessDate);
  return `${businessDate.replace(/-/g, '')}${String((count ?? 0) + 1).padStart(3, '0')}`;
}
