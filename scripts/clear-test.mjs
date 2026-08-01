// Clear TEST intake data from Mongo/Atlas — keeps the Turboly mirror + refdata.
//
//   node --env-file=.env scripts/clear-test.mjs           # DRY RUN (shows what would go)
//   node --env-file=.env scripts/clear-test.mjs --yes     # actually delete
//   node --env-file=.env scripts/clear-test.mjs --yes --vehicles   # also clear the vehicles cache
//
// Deletes:  spk, spk_events, turboly_docs, push_dlq   (+ vehicles with --vehicles)
// KEEPS:    tb_stores, tb_mechanics, tb_service_products, service_sku_map, degradation_state
// NOTE: Service Orders already created in Turboly (SRO/BKS/...) are NOT affected — this only
//       clears the local intake DB. Those live in Turboly (sandbox) and are cleared there.
import { MongoClient } from 'mongodb';

const yes = process.argv.includes('--yes');
const alsoVehicles = process.argv.includes('--vehicles');
const targets = ['spk', 'spk_events', 'turboly_docs', 'push_dlq', ...(alsoVehicles ? ['vehicles'] : [])];

const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db(process.env.MONGODB_DB || 'spk');

console.log(yes ? '=== DELETING ===' : '=== DRY RUN (add --yes to delete) ===');
for (const name of targets) {
  const col = db.collection(name);
  const n = await col.countDocuments();
  if (yes) {
    const r = await col.deleteMany({});
    console.log(`  ${name.padEnd(16)} deleted ${r.deletedCount}`);
  } else {
    console.log(`  ${name.padEnd(16)} would delete ${n}`);
  }
}
console.log('kept: tb_stores, tb_mechanics, tb_service_products, service_sku_map' + (alsoVehicles ? '' : ', vehicles'));
await c.close();
