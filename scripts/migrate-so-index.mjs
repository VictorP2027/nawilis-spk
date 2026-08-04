// One-off: move the "one Turboly order per SPK" guard from the printed doc
// NUMBER to the document URL (which carries Turboly's own record id).
//
//   node --env-file=.env scripts/migrate-so-index.mjs
//
// Why: doc numbers are only unique inside a tenant's counter. A sandbox reset
// (or any tenant renumbering) hands a genuinely NEW order a number an old SPK
// already holds — the push then failed AFTER the order existed, and the retry
// would have created a second one.
import { MongoClient } from 'mongodb';

const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const spk = c.db(process.env.MONGODB_DB || 'spk').collection('spk');

const before = await spk.indexes();
console.log('before:', before.map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`).join(', '));

// Refuse to create a broken unique index: two docs must never share one URL.
const dupUrls = await spk
  .aggregate([
    { $match: { 'turboly.serviceOrderUrl': { $type: 'string' } } },
    { $group: { _id: '$turboly.serviceOrderUrl', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ])
  .toArray();
if (dupUrls.length) {
  console.error('ABORT — URL sudah dipakai lebih dari satu dokumen:');
  for (const d of dupUrls) console.error(`  ${d._id} → ${d.ids.join(', ')}`);
  process.exit(1);
}

for (const [name, spec] of [
  ['uq_turboly_so', { 'turboly.serviceOrderNo': 1 }],
  ['uq_turboly_swo', { 'turboly.workOrderNo': 1 }],
]) {
  if (before.some((i) => i.name === name)) {
    await spk.dropIndex(name);
    console.log(`dropped ${name}`);
  }
  void spec;
}

await spk.createIndexes([
  {
    key: { 'turboly.serviceOrderUrl': 1 },
    name: 'uq_turboly_so_url',
    unique: true,
    partialFilterExpression: { 'turboly.serviceOrderUrl': { $type: 'string' } },
  },
  { key: { 'turboly.serviceOrderNo': 1 }, name: 'ix_turboly_so' },
  { key: { 'turboly.workOrderNo': 1 }, name: 'ix_turboly_swo' },
]);

const after = await spk.indexes();
console.log('after: ', after.map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`).join(', '));
await c.close();
