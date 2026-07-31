import { MongoClient, type Db, type Collection } from 'mongodb';
import type {
  SpkDoc, SpkEvent, TurbolyClaim, VehicleDoc, TbStore, TbServiceProduct,
  TbMechanic, TbCredential, ReconRun, DlqItem, ServiceSkuMap, DegradationState,
} from './types.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connect(uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017', dbName = process.env.MONGODB_DB ?? 'spk'): Promise<Db> {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  return db;
}

export async function close(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}

export function getDb(): Db {
  if (!db) throw new Error('Mongo not connected — call connect() first');
  return db;
}

export const collections = {
  spk: () => getDb().collection<SpkDoc>('spk'),
  spkEvents: () => getDb().collection<SpkEvent>('spk_events'),
  turbolyDocs: () => getDb().collection<TurbolyClaim>('turboly_docs'),
  vehicles: () => getDb().collection<VehicleDoc>('vehicles'),
  tbStores: () => getDb().collection<TbStore>('tb_stores'),
  tbServiceProducts: () => getDb().collection<TbServiceProduct>('tb_service_products'),
  tbMechanics: () => getDb().collection<TbMechanic>('tb_mechanics'),
  tbCredentials: () => getDb().collection<TbCredential>('tb_credentials'),
  serviceSkuMap: () => getDb().collection<ServiceSkuMap>('service_sku_map'),
  degradation: () => getDb().collection<DegradationState>('degradation_state'),
  reconRuns: () => getDb().collection<ReconRun>('recon_runs'),
  dlq: () => getDb().collection<DlqItem>('push_dlq'),
} as const;

/**
 * Create every index the query patterns need — and, critically, the unique
 * indexes that make double-push structurally impossible.
 */
export async function ensureIndexes(): Promise<void> {
  const d = getDb();

  const spk = d.collection<SpkDoc>('spk');
  await spk.createIndexes([
    // Push queue scan (poller): find work by state + due time.
    { key: { state: 1, 'push.nextAttemptAt': 1, 'push.priority': -1 }, name: 'ix_push_queue' },
    // Vehicle history by plate + all OCR-confusion variants (multikey).
    { key: { 'vehicle.plateVariants': 1 }, name: 'ix_plate_variants' },
    // Daily ops dashboards.
    { key: { branchCode: 1, 'capture.businessDate': 1 }, name: 'ix_branch_day' },
    // Reconciliation harvest by token.
    { key: { 'push.correlationToken': 1 }, name: 'uq_correlation_token', unique: true },
    // Turboly doc numbers, once known. PARTIAL (not sparse): sparse still indexes
    // `null`, so every fresh doc (serviceOrderNo:null) would collide. Partial on
    // $type:'string' means only real, assigned doc numbers are uniqueness-checked
    // — this is the storage-layer guard that makes a duplicate Service Order impossible.
    { key: { 'turboly.serviceOrderNo': 1 }, name: 'uq_turboly_so', unique: true, partialFilterExpression: { 'turboly.serviceOrderNo': { $type: 'string' } } },
    { key: { 'turboly.workOrderNo': 1 }, name: 'uq_turboly_swo', unique: true, partialFilterExpression: { 'turboly.workOrderNo': { $type: 'string' } } },
    // Field-meta queries MUST use $elemMatch; this supports them.
    { key: { 'fieldMeta.path': 1 }, name: 'ix_fieldmeta_path' },
    // Idempotent capture on client uploadId.
    { key: { uploadId: 1 }, name: 'uq_upload_id', unique: true, sparse: true },
    // Age-in-state alerts.
    { key: { state: 1, updatedAt: 1 }, name: 'ix_state_age' },
  ]);

  // Claim table: _id is `${spkId}#${phase}`; a unique index there is what makes
  // "two workers both create the SO" impossible at the storage layer.
  const claims = d.collection<TurbolyClaim>('turboly_docs');
  await claims.createIndexes([
    { key: { correlationToken: 1, phase: 1 }, name: 'uq_token_phase', unique: true },
    { key: { spkId: 1 }, name: 'ix_claim_spk' },
  ]);

  const vehicles = d.collection<VehicleDoc>('vehicles');
  await vehicles.createIndexes([
    { key: { plateVariants: 1 }, name: 'ix_veh_plate_variants' },
    { key: { plateFull: 1 }, name: 'uq_veh_plate', unique: true },
  ]);

  const events = d.collection<SpkEvent>('spk_events');
  await events.createIndexes([
    { key: { spkId: 1, at: 1 }, name: 'ix_event_spk' },
    { key: { type: 1, at: 1 }, name: 'ix_event_type' },
  ]);

  const dlq = d.collection<DlqItem>('push_dlq');
  await dlq.createIndexes([
    { key: { failureClass: 1, enqueuedAt: 1 }, name: 'ix_dlq_class' },
    { key: { resolvedAt: 1 }, name: 'ix_dlq_open' },
  ]);
}
