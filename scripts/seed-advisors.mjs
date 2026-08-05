// Harvest the REAL service advisors + salespeople for a branch from Turboly's
// live Service Order form and seed them into tb_mechanics (replacing the demo
// placeholder). Advisors/salespeople are store-scoped in Turboly.
//
//   node --env-file=.env scripts/seed-advisors.mjs            # NWL-BKS
//   node --env-file=.env scripts/seed-advisors.mjs NWL-PRG    # another branch
import { connect, close, collections, loadMirror } from '../packages/core/dist/index.js';
import { TurbolySession } from '../packages/core/dist/turboly/index.js';

const branch = process.argv[2] || 'NWL-BKS';
const base = process.env.TURBOLY_BASE_URL || 'https://sandbox.turboly.com';
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');

const store = await collections.tbStores().findOne({ _id: branch });
if (!store?.turbolyStoreId) { console.error(`No turbolyStoreId for ${branch} — seed the store first.`); await close(); process.exit(1); }

const session = new TurbolySession({ baseUrl: base, stateDir: './.turboly-state', userAgentSuffix: 'seed', branchCode: branch });
await session.start(); await session.ensureLoggedIn();
const page = session.page_();
await page.goto(`${base}/service_orders/new`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.selectOption('#store-id', { value: store.turbolyStoreId });
await page.waitForTimeout(2800); // advisors/salespeople load after store (AJAX)

const read = (sel) => page.$$eval(`${sel} option`, (els) => els.map((e) => ({ v: e.value, t: (e.textContent || '').trim() })).filter((o) => o.v && o.t));
const advisors = await read('#service-advisor-id');
const sales = await read('#salesperson-id');
console.log(`${branch} (store ${store.turbolyStoreId}): ${advisors.length} advisors, ${sales.length} salespeople`);

const now = new Date().toISOString();
const seen = new Set();
let n = 0;
for (const a of advisors) {
  await collections.tbMechanics().updateOne({ _id: `${branch}:${a.v}` }, { $set: { _id: `${branch}:${a.v}`, mechanicCode: a.v, name: a.t, storeCode: branch, role: 'advisor', syncedAt: now } }, { upsert: true });
  seen.add(a.v); n++;
}
for (const s of sales) {
  if (seen.has(s.v)) continue;
  await collections.tbMechanics().updateOne({ _id: `${branch}:${s.v}` }, { $set: { _id: `${branch}:${s.v}`, mechanicCode: s.v, name: s.t, storeCode: branch, role: 'salesperson', syncedAt: now } }, { upsert: true });
  n++;
}
// drop the demo placeholder
const del = await collections.tbMechanics().deleteMany({ _id: 'DEMO-ADV' });
console.log(`seeded ${n} mechanics for ${branch}; removed demo placeholder: ${del.deletedCount}`);
console.log('advisors:', advisors.map((a) => a.t).join(', '));

const mirror = await loadMirror(branch);
console.log('mirror advisorByName now has', mirror.advisorByName.size, 'names');
await session.dispose(); await close();
