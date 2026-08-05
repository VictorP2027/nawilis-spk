// Hourly catalog re-sync — keeps the Mongo mirrors fresh from Turboly's live UI:
//   tb_stores (names), tb_mechanics (advisors/salespeople per branch),
//   vehicle_makes (list), vehicle_models_map (per make).
// Service SKU mappings are HUMAN-CONFIRMED and never auto-synced.
//
//   node --env-file=.env scripts/sync-catalogs.mjs
//
// One Turboly session (one login). In CI this runs in the same concurrency
// group as the pusher so the two can never fight over the single session.
import { connect, close, collections } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';
import { TurbolySession } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/turboly/index.js';
import { getDb } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/mongo.js';

const base = process.env.TURBOLY_BASE_URL || 'https://sandbox.turboly.com';
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const now = new Date().toISOString();

const session = new TurbolySession({ baseUrl: base, stateDir: './.turboly-state', userAgentSuffix: 'sync', branchCode: 'NWL-BKS' });
await session.start();
await session.ensureLoggedIn();
const page = session.page_();
const read = (sel) => page.$$eval(`${sel} option`, (els) => els.map((e) => ({ v: e.value, t: (e.textContent || '').trim() })).filter((o) => o.v && o.t));
// Poll until a select actually has options — fixed waits race the AJAX and a
// flaky read must NEVER look like "the list is now empty".
const readPoll = async (sel, tries = 14, gap = 500) => {
  for (let i = 0; i < tries; i++) {
    const out = await read(sel).catch(() => []);
    if (out.length > 0) return out;
    await page.waitForTimeout(gap);
  }
  return [];
};

// MECHANICS are not on the Service Order form at all, which is why this mirror
// held 0 of them and the board offered advisors that Turboly then refused as WO
// assignees ("Assignee can't be blank"). They come from the store_users lookup
// WITHOUT context=ServiceOrder — that context returns the advisors instead.
// Same path, two different lists.
//
// Being a mechanic is a CAPABILITY, not a replacement role: the same person can
// be an advisor and a mechanic (ANERIA PUSPITA DEWI, 21809, is both at Ciputat),
// so this sets a flag and never overwrites `role`.
//
// Called BEFORE the advisor read, because a store whose advisor list comes back
// empty is skipped — and 12 of 23 branches got no mechanics at all when this
// lived after that gate.
async function syncMechanics(st, ls) {
  try {
    const mechs = await page.evaluate(`(async () => {
      var r = await fetch('/lookup/store_users.json?store_id=${String(ls.v)}', { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      try { return await r.json(); } catch (e) { return null; }
    })()`);
    if (!Array.isArray(mechs) || !mechs.length) {
      console.log(`  ${st._id}: mechanic list empty — flag left as-is (not cleared)`);
      return;
    }
    await collections.tbMechanics().updateMany({ storeCode: st._id }, { $unset: { isMechanic: '' } });
    for (const row of mechs) {
      const mid = String(row[1] ?? '');
      const mname = String(row[0] ?? '').trim();
      if (!mid || !mname) continue;
      await collections.tbMechanics().updateOne(
        { _id: `${st._id}:${mid}` },
        {
          $set: { mechanicCode: mid, name: mname, storeCode: st._id, isMechanic: true, syncedAt: now },
          $setOnInsert: { role: 'mechanic' },
        },
        { upsert: true },
      );
    }
    mechTotal += mechs.length;
  } catch (e) {
    console.log(`  ${st._id} mechanics ERROR: ${e.message.slice(0, 60)}`);
  }
}

// ── 1+2. stores + advisors (SO form) ─────────────────────────────────────
await page.goto(`${base}/service_orders/new`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const liveStores = await readPoll('#store-id');
const known = await collections.tbStores().find({}).toArray();
const byTurbolyId = new Map(known.map((s) => [String(s.turbolyStoreId), s]));
let advTotal = 0;
let mechTotal = 0;
const newStores = [];
const okStores = [];
for (const ls of liveStores) {
  const st = byTurbolyId.get(String(ls.v));
  if (!st) { newStores.push(`${ls.t} (id ${ls.v})`); continue; } // needs a manual branchCode mapping
  await collections.tbStores().updateOne({ _id: st._id }, { $set: { turbolyStoreName: ls.t, syncedAt: now } });
  try {
    await page.selectOption('#store-id', { value: String(ls.v) });
    await page.waitForTimeout(1200);
    await syncMechanics(st, ls);
    const advisors = await readPoll('#service-advisor-id');
    const sales = await read('#salesperson-id');
    if (advisors.length === 0) { console.log(`  ${st._id}: advisor list empty — SKIPPED (not pruned)`); continue; }
    okStores.push(st._id);
    const seen = new Set();
    for (const a of advisors) { await collections.tbMechanics().updateOne({ _id: `${st._id}:${a.v}` }, { $set: { _id: `${st._id}:${a.v}`, mechanicCode: a.v, name: a.t, storeCode: st._id, role: 'advisor', syncedAt: now } }, { upsert: true }); seen.add(a.v); }
    for (const p of sales) {
      if (seen.has(p.v)) { await collections.tbMechanics().updateOne({ _id: `${st._id}:${p.v}` }, { $set: { alsoSalesperson: true } }); continue; }
      await collections.tbMechanics().updateOne({ _id: `${st._id}:${p.v}` }, { $set: { _id: `${st._id}:${p.v}`, mechanicCode: p.v, name: p.t, storeCode: st._id, role: 'salesperson', syncedAt: now } }, { upsert: true });
    }
    advTotal += advisors.length;

  } catch (e) {
    console.log(`  ${st._id} advisors ERROR: ${e.message.slice(0, 60)}`);
  }
}
// prune advisors that vanished — ONLY for stores whose list we read successfully
const pruned = await collections.tbMechanics().deleteMany({ role: { $in: ['advisor', 'salesperson'] }, storeCode: { $in: okStores }, syncedAt: { $lt: now } });
console.log(`stores: ${liveStores.length} live (${newStores.length} unmapped) | advisors synced: ${advTotal}, pruned: ${pruned.deletedCount} | mechanics synced: ${mechTotal}`);
if (newStores.length) console.log(`  ⚠ NEW stores need branchCode mapping: ${newStores.join('; ')}`);

// ── 3+4. vehicle makes + models (/vehicles/new) ──────────────────────────
await page.goto(`${base}/vehicles/new`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const makes = await readPoll('#vehicle-make-select', 20);
if (makes.length > 10) {
  await getDb().collection('vehicle_makes').updateOne({ _id: 'makes' }, { $set: { list: makes.map((m) => m.t), syncedAt: now } }, { upsert: true });
  const byMake = {};
  for (const mk of makes) {
    try {
      // Models come from a paginated JSON lookup (same one the select2 uses).
      byMake[mk.t] = await page.evaluate(async (makeId) => {
        const out = [];
        for (let pg = 1; pg <= 20; pg++) {
          const r = await fetch(`/lookup/vehicle_models?search_term=&vehicle_type=&vehicle_make=${makeId}&page=${pg}&page_limit=100`, { headers: { accept: 'application/json' } });
          if (!r.ok) break;
          const j = await r.json();
          const list = j.vehicle_models ?? [];
          out.push(...list.map((m) => m.name));
          if (list.length < 100) break;
        }
        return out;
      }, mk.v);
    } catch { byMake[mk.t] = []; }
  }
  // Per-make MERGE: a make whose harvest came back empty keeps its previous
  // models — a flaky fetch must never blank out a make (e.g. HONDA → []).
  const prev = (await getDb().collection('vehicle_models_map').findOne({ _id: 'byMake' }))?.byMake ?? {};
  const merged = { ...prev };
  let fresh = 0, kept = 0;
  for (const [mk, models] of Object.entries(byMake)) {
    if (models.length > 0) { merged[mk] = models; fresh++; }
    else if ((prev[mk] ?? []).length > 0) { kept++; }
    else { merged[mk] = []; }
  }
  const total = Object.values(merged).reduce((s, a) => s + a.length, 0);
  await getDb().collection('vehicle_models_map').updateOne({ _id: 'byMake' }, { $set: { byMake: merged, syncedAt: now } }, { upsert: true });
  console.log(`makes: ${makes.length} | models total: ${total} (${fresh} makes fresh, ${kept} kept previous)`);
} else {
  console.log(`make list looked broken (${makes.length}) — makes/models NOT overwritten`);
}

await session.dispose();
await close();
console.log('sync done');
