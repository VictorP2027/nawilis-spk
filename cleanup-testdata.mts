/**
 * ONE-OFF: drop the accumulated Turboly test data, keeping only the two
 * documents that reached a completed invoice — and their own history.
 *
 * Backups written before any of this ran:
 *   scratchpad/backup-spk.json        (43 docs)
 *   scratchpad/backup-flow_jobs.json  (71 jobs)
 *
 * IMPORTANT: MONGO ONLY. The Service Orders and Work Orders these documents
 * point at stay in the Turboly sandbox; Mongo forgetting them does not undo
 * them there.
 *
 * REFERENCE DATA IS NEVER TOUCHED. tb_mechanics (1460 rows, incl. the 241
 * mechanics across 23 branches), tb_stores, tb_store_ignores, service_sku_map
 * (human-confirmed, never auto-synced), tb_service_products, service_options,
 * vehicle_makes and vehicle_models_map are what the whole pipeline resolves
 * against. Clearing them would not be a clean slate, it would be an outage.
 *
 * Idempotent: re-running once clean deletes nothing.
 *
 *   npx tsx cleanup-testdata.mts          # dry run
 *   npx tsx cleanup-testdata.mts --apply  # delete
 */
import { connect, close, collections, getDb } from '@spk/core';
import { config } from './apps/worker/src/config.js';

/** The only two documents that ever reached a completed invoice. */
const KEEP = [
  '01KZ67RHMZTFS6N3N1QVY4YQRY', // B 7577 WHL — SRI/BKS/26080028
  '01KZ7GWB52RBFBMTCK93XKVF95', // B 6977 WHL — SRI/BKS/26080027
];

const apply = process.argv.includes('--apply');
await connect(config.mongoUri, config.mongoDb);
const db = getDb();
const spk = collections.spk();

const kept = (await spk.find({ _id: { $in: KEEP } } as never).toArray()) as Array<Record<string, any>>;
const doomed = (
  (await spk.find({ _id: { $nin: KEEP } } as never).project({ _id: 1 }).toArray()) as Array<{ _id: string }>
).map((d) => d._id);

// Vehicles are keyed by plate, not by spkId, so the two survivors are matched
// on the plate they carry. No turbolyVehicleId is stored here — this mirror is
// local visit history (visitCount, lastKm, plateVariants), which is why
// clearing it cannot orphan or duplicate a vehicle inside Turboly.
const keepPlates = kept.flatMap((d) => [d.vehicle?.noPolisi?.full, d.vehicle?.noPolisi?.display].filter(Boolean));

const plan: Array<[string, Record<string, unknown>]> = [
  // Jobs first: a flow_job whose document is gone gets claimed by the worker
  // and fails on "Dokumen … tidak ditemukan di Mongo" forever. spkId '' is the
  // customer-registration jobs, which belong to no document at all.
  ['flow_jobs', { $or: [{ spkId: { $nin: KEEP } }, { spkId: '' }] }],
  ['spk_events', { spkId: { $nin: KEEP } }],
  ['vehicles', { plateFull: { $nin: keepPlates } }],
  ['spk', { _id: { $nin: KEEP } }],
];

console.log(`${apply ? 'DELETING' : 'dry run —'} ${doomed.length} spk docs; keeping ${kept.length} (${keepPlates.join(', ')})\n`);
for (const [name, filter] of plan) {
  const col = db.collection(name);
  const n = await col.countDocuments(filter as never);
  if (apply && n > 0) {
    const r = await col.deleteMany(filter as never);
    console.log(`  ${name.padEnd(12)} deleted ${r.deletedCount}`);
  } else {
    console.log(`  ${name.padEnd(12)} ${apply ? 'nothing to delete' : `would delete ${n}`}`);
  }
}

console.log('\n--- remaining ---');
for (const name of ['spk', 'flow_jobs', 'spk_events', 'vehicles', 'tb_stores', 'tb_mechanics', 'service_sku_map']) {
  console.log(`  ${name.padEnd(16)} ${await db.collection(name).countDocuments({})}`);
}
for (const d of (await spk.find({} as never).toArray()) as Array<Record<string, any>>) {
  console.log(
    `  KEPT ${d.vehicle?.noPolisi?.display} ${d.branchCode} SO=${d.turboly?.serviceOrderNo} ` +
      `WO=${d.turboly?.workOrderNo} INV=${d.flow?.invoiceNo}`,
  );
}
await close();
process.exit(0);
