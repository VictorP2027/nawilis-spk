// Seed ALL branch stores + harvest each branch's real advisors/salespeople from
// Turboly's live SO form. One login, branches done serially (one Turboly session).
//   node --env-file=.env scripts/seed-all-branches.mjs
import fs from 'node:fs';
import { connect, close, collections } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';
import { TurbolySession } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/turboly/index.js';

const base = process.env.TURBOLY_BASE_URL || 'https://sandbox.turboly.com';
const stores = JSON.parse(fs.readFileSync('data/turboly-sandbox-stores.json', 'utf8'));
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const now = new Date().toISOString();

// 1. seed all branch stores (so loadMirror finds a store for every branch)
for (const s of stores) {
  await collections.tbStores().updateOne({ _id: s.branchCode }, { $set: { _id: s.branchCode, turbolyStoreId: s.turbolyStoreId, turbolyStoreName: s.turbolyStoreName, syncedAt: now } }, { upsert: true });
}
console.log(`seeded ${stores.length} stores into tb_stores`);

// 2. harvest advisors + salespeople per branch
const session = new TurbolySession({ baseUrl: base, stateDir: './.turboly-state', userAgentSuffix: 'seed-all', branchCode: 'NWL-BKS' });
await session.start(); await session.ensureLoggedIn();
const page = session.page_();
const read = (sel) => page.$$eval(`${sel} option`, (els) => els.map((e) => ({ v: e.value, t: (e.textContent || '').trim() })).filter((o) => o.v && o.t));

let totalAdv = 0;
for (const s of stores) {
  try {
    await page.goto(`${base}/service_orders/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.selectOption('#store-id', { value: s.turbolyStoreId });
    await page.waitForTimeout(2600); // advisors load after store (AJAX)
    const advisors = await read('#service-advisor-id');
    const sales = await read('#salesperson-id');
    const seen = new Set();
    for (const a of advisors) { await collections.tbMechanics().updateOne({ _id: `${s.branchCode}:${a.v}` }, { $set: { _id: `${s.branchCode}:${a.v}`, mechanicCode: a.v, name: a.t, storeCode: s.branchCode, role: 'advisor', syncedAt: now } }, { upsert: true }); seen.add(a.v); }
    for (const p of sales) { if (seen.has(p.v)) continue; await collections.tbMechanics().updateOne({ _id: `${s.branchCode}:${p.v}` }, { $set: { _id: `${s.branchCode}:${p.v}`, mechanicCode: p.v, name: p.t, storeCode: s.branchCode, role: 'salesperson', syncedAt: now } }, { upsert: true }); }
    totalAdv += advisors.length;
    console.log(`${s.branchCode.padEnd(9)} ${String(advisors.length).padStart(2)} advisors, ${String(sales.length).padStart(2)} sales  [${advisors.map((a) => a.t).join(', ') || '—'}]`);
  } catch (e) {
    console.log(`${s.branchCode.padEnd(9)} ERROR: ${e.message.slice(0, 60)}`);
  }
}
await collections.tbMechanics().deleteMany({ _id: 'DEMO-ADV' });
console.log(`\nDONE: ${stores.length} branches, ${totalAdv} advisors total; demo placeholder removed`);
await session.dispose(); await close();
