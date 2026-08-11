import { readFileSync, writeFileSync } from 'node:fs';
for (const line of readFileSync('/Users/victorphisitkul/Desktop/nawilis-spk-v2/.env', 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
process.env.MONGODB_DB = 'spk';
const APPLY = process.argv[2] === '--apply';
const core = await import('@spk/core');
await core.connect();
const db = core.getDb();
if (db.databaseName !== 'spk') { console.log('REFUSING — connected to', db.databaseName); process.exit(1); }

const docs = await db.collection('spk').find({}, { projection: { 'vehicle.noPolisi':1, 'customer.waE164':1 } }).toArray();
const plan = [];
for (const d of docs) {
  const np = d.vehicle?.noPolisi ?? {};
  const before = np.display ?? '';
  const after = before.replace(/\s+/g, '');
  // The canonical `full` is the authority; a display that disagrees with it is
  // a bug, not a formatting choice, so refuse rather than paper over it.
  if (np.full && after && after !== np.full) { console.log(`SKIP ${d._id}: display "${before}" ≠ full "${np.full}"`); continue; }
  const wa = d.customer?.waE164 ?? '';
  const waAfter = wa ? core.e164Phone(wa) : wa;
  if (before !== after || wa !== waAfter) plan.push({ _id: d._id, before, after, wa, waAfter });
}
console.log(`${plan.length} of ${docs.length} documents need normalising\n`);
for (const p of plan.slice(0, 6)) console.log(`   ${p._id}  "${p.before}" → "${p.after}"${p.wa !== p.waAfter ? `   phone "${p.wa}" → "${p.waAfter}"` : ''}`);
if (plan.length > 6) console.log(`   … and ${plan.length - 6} more`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Pass --apply to write.'); process.exit(0); }

writeFileSync(process.argv[3], JSON.stringify(plan, null, 1));
let n = 0;
for (const p of plan) {
  const set = { 'vehicle.noPolisi.display': p.after };
  if (p.wa !== p.waAfter) set['customer.waE164'] = p.waAfter;
  const r = await db.collection('spk').updateOne({ _id: p._id }, { $set: set });
  n += r.modifiedCount;
}
console.log(`\nwrote ${n} documents; reversal file saved`);
process.exit(0);
