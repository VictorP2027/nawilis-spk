// Remove LOADTEST burst-test data from Mongo (Turboly sandbox SOs stay; they
// can be cancelled in bulk from the Turboly UI if wanted).
//
//   node --env-file=.env scripts/clear-loadtest.mjs        # DRY RUN
//   node --env-file=.env scripts/clear-loadtest.mjs --yes  # delete
import { MongoClient } from 'mongodb';

const yes = process.argv.includes('--yes');
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db(process.env.MONGODB_DB || 'spk');
const q = { 'customer.nama': /^LOADTEST \d\d$/ };
const docs = await db.collection('spk').find(q, { projection: { 'customer.nama': 1, 'vehicle.noPolisi.full': 1, state: 1, 'turboly.serviceOrderNo': 1 } }).toArray();
console.log(`${docs.length} LOADTEST docs:`);
for (const d of docs) console.log(`  ${d.customer.nama}  ${d.vehicle?.noPolisi?.full}  ${d.state}  ${d.turboly?.serviceOrderNo ?? '-'}`);
if (yes && docs.length) {
  const ids = docs.map((d) => d._id);
  const r = await db.collection('spk').deleteMany({ _id: { $in: ids } });
  const e = await db.collection('spk_events').deleteMany({ spkId: { $in: ids.map(String) } });
  console.log(`deleted ${r.deletedCount} spk + ${e.deletedCount} events`);
} else if (docs.length) {
  console.log('(dry run — add --yes to delete)');
}
await c.close();
