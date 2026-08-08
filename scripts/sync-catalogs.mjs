// Hourly catalog re-sync — keeps the Mongo mirrors fresh from Turboly's live UI:
//   tb_stores (names), tb_mechanics (advisors/salespeople per branch),
//   vehicle_makes (list), vehicle_models_map (per make).
// Service SKU mappings are HUMAN-CONFIRMED and never auto-synced.
//
//   node --env-file=.env scripts/sync-catalogs.mjs
//
// One Turboly session (one login). In CI this runs in the same concurrency
// group as the pusher so the two can never fight over the single session.
import { connect, close, collections } from '../packages/core/dist/index.js';
import { TurbolySession } from '../packages/core/dist/turboly/index.js';
import { getDb } from '../packages/core/dist/mongo.js';

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
/**
 * One store_users read, reporting HOW it failed rather than collapsing every
 * outcome to null. "Turboly says this store has no mechanics" and "the request
 * did not come back" both used to arrive here as an empty array, and the only
 * thing anyone downstream saw was a branch that silently could not staff a Work
 * Order.
 */
async function fetchStoreUsers(storeId) {
  return page.evaluate(`(async () => {
    try {
      var r = await fetch('/lookup/store_users.json?store_id=${String(storeId)}', { headers: { accept: 'application/json' } });
      if (!r.ok) return { ok: false, status: r.status };
      var j = await r.json();
      return { ok: true, status: r.status, rows: Array.isArray(j) ? j : null };
    } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; }
  })()`);
}

/**
 * Poll it, for the same reason readPoll exists a few lines up: this fires
 * immediately after selectOption, while Turboly is still running its own AJAX
 * for the advisor selects, and a single un-retried read that loses that race is
 * indistinguishable from an empty store. Every other list in this file is
 * polled; this one was not.
 */
async function readMechanicsPoll(storeId, tries = 8, gap = 600) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await fetchStoreUsers(storeId).catch((e) => ({ ok: false, status: -1, error: e.message }));
    if (last && last.ok && Array.isArray(last.rows) && last.rows.length) return last;
    await page.waitForTimeout(gap);
  }
  return last;
}

async function syncMechanics(st, ls) {
  try {
    const res = await readMechanicsPoll(ls.v);
    if (!res || !res.ok) {
      // Our side broke. Says nothing about whether the store has mechanics, so
      // the existing flags stay exactly as they are. 401 is its own answer:
      // the session is gone, and the caller can get it back.
      if (res?.status === 401) return 'auth';
      console.log(`  ${st._id}: mechanic lookup FAILED (status ${res?.status ?? '?'}${res?.error ? ` — ${res.error}` : ''}) — flag left as-is`);
      mechFailed.push(st._id);
      return 'failed';
    }
    const mechs = res.rows ?? [];
    if (!mechs.length) {
      // Turboly answered, and the answer is "nobody". That is a Turboly
      // configuration gap, not a sync bug — and it means this branch cannot
      // create a Work Order at all, so it has to be named in the summary.
      console.log(`  ${st._id}: Turboly returned ZERO mechanics (HTTP ${res.status}) — no mechanic configured for this store`);
      mechEmpty.push(st._id);
      return 'empty';
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
    mechOk.push(st._id);
    return 'ok';
  } catch (e) {
    console.log(`  ${st._id} mechanics ERROR: ${e.message.slice(0, 60)}`);
    mechFailed.push(st._id);
    return 'failed';
  }
}

// ── 1+2. stores + advisors (SO form) ─────────────────────────────────────
await page.goto(`${base}/service_orders/new`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const liveStores = await readPoll('#store-id');
const known = await collections.tbStores().find({}).toArray();
const byTurbolyId = new Map(known.map((s) => [String(s.turbolyStoreId), s]));
// Turboly's store dropdown carries more than the 23 workshops: the holding
// companies are in there too, and they have no staff, no orders and no branch
// code. Listing them as "needs a branchCode mapping" every run trains everyone
// to ignore that warning — which is the one warning that has to still work the
// day a genuinely new outlet opens.
const ignoredStoreIds = new Set(
  (await getDb().collection('tb_store_ignores').find({}).toArray()).map((r) => String(r._id)),
);
let advTotal = 0;
let mechTotal = 0;
// Which branches ended up with mechanics, which Turboly says have none, and
// which we simply failed to ask. A branch with no mechanics cannot be assigned
// a Work Order, so "0 mechanics" must never be a line nobody reads.
const mechOk = [];
const mechEmpty = [];
const mechFailed = [];
const newStores = [];
const okStores = [];
/**
 * Turboly allows ONE SESSION PER USER, so any other login — the pusher, the
 * flow worker, a person opening Turboly — takes the account from this run
 * mid-sweep. It shows as a clean TAIL of failures: from the kick onward every
 * store 401s and every advisor select comes back empty, so whichever branches
 * happened to be later in the list look like they have no staff at all. That
 * is exactly how 12 of 23 branches came to have no mechanics mirrored.
 *
 * So get the session back instead of writing off the rest of the run. Bounded,
 * and paced: Turboly answers a burst of logins with HTTP 429.
 */
let relogins = 0;
const MAX_RELOGINS = 5;
async function recoverSession(why) {
  if (relogins >= MAX_RELOGINS) {
    console.log(`  ✗ session kicked again at ${why} — ${MAX_RELOGINS} re-logins already spent, giving up`);
    return false;
  }
  relogins += 1;
  console.log(`  ↻ session kicked at ${why} — logging back in (${relogins}/${MAX_RELOGINS})`);
  await page.waitForTimeout(5000);
  try {
    await session.ensureLoggedIn();
    await page.goto(`${base}/service_orders/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await readPoll('#store-id');
    return true;
  } catch (e) {
    console.log(`  ✗ re-login failed: ${e.message.slice(0, 80)}`);
    return false;
  }
}

/**
 * One store's mechanics + advisors. Returns 'auth' when the session is gone,
 * so the caller can recover and run it again — the read is idempotent, every
 * write is an upsert keyed on `${branch}:${id}`.
 */
async function syncOneStore(st, ls) {
  await page.selectOption('#store-id', { value: String(ls.v) });
  await page.waitForTimeout(1200);
  const mech = await syncMechanics(st, ls);
  if (mech === 'auth') return 'auth';
  const advisors = await readPoll('#service-advisor-id');
  const sales = await read('#salesperson-id');
  if (advisors.length === 0) {
    // An empty advisor list right after a mechanic 401 is the same kick seen
    // twice; on its own it is a store with nobody assigned. Either way: not
    // pruned, because we cannot tell an empty list from an unread one.
    return 'empty-advisors';
  }
  okStores.push(st._id);
  {
    const seen = new Set();
    for (const a of advisors) { await collections.tbMechanics().updateOne({ _id: `${st._id}:${a.v}` }, { $set: { _id: `${st._id}:${a.v}`, mechanicCode: a.v, name: a.t, storeCode: st._id, role: 'advisor', syncedAt: now } }, { upsert: true }); seen.add(a.v); }
    for (const p of sales) {
      if (seen.has(p.v)) { await collections.tbMechanics().updateOne({ _id: `${st._id}:${p.v}` }, { $set: { alsoSalesperson: true } }); continue; }
      await collections.tbMechanics().updateOne({ _id: `${st._id}:${p.v}` }, { $set: { _id: `${st._id}:${p.v}`, mechanicCode: p.v, name: p.t, storeCode: st._id, role: 'salesperson', syncedAt: now } }, { upsert: true });
    }
    advTotal += advisors.length;
  }
  return 'ok';
}

for (const ls of liveStores) {
  const st = byTurbolyId.get(String(ls.v));
  if (!st) {
    if (!ignoredStoreIds.has(String(ls.v))) newStores.push(`${ls.t} (id ${ls.v})`); // needs a manual branchCode mapping
    continue;
  }
  await collections.tbStores().updateOne({ _id: st._id }, { $set: { turbolyStoreName: ls.t, syncedAt: now } });
  try {
    let status = await syncOneStore(st, ls);
    if (status === 'auth' && (await recoverSession(st._id))) status = await syncOneStore(st, ls);
    if (status === 'auth') {
      console.log(`  ${st._id}: session still dead — flag left as-is`);
      mechFailed.push(st._id);
    } else if (status === 'empty-advisors') {
      console.log(`  ${st._id}: advisor list empty — SKIPPED (not pruned)`);
    }
  } catch (e) {
    console.log(`  ${st._id} ERROR: ${e.message.slice(0, 60)}`);
  }
}
// prune advisors that vanished — ONLY for stores whose list we read successfully
const pruned = await collections.tbMechanics().deleteMany({ role: { $in: ['advisor', 'salesperson'] }, storeCode: { $in: okStores }, syncedAt: { $lt: now } });
console.log(`stores: ${liveStores.length} live (${newStores.length} unmapped) | advisors synced: ${advTotal}, pruned: ${pruned.deletedCount} | mechanics synced: ${mechTotal} across ${mechOk.length} branches`);
if (newStores.length) console.log(`  ⚠ NEW stores need branchCode mapping: ${newStores.join('; ')}`);
// The two ways a branch ends up unable to staff a Work Order, kept apart on
// purpose: the first needs someone to fix Turboly, the second needs someone to
// fix us. Naming them is the point — the count alone hid 12 branches for weeks.
if (mechEmpty.length) console.log(`  ⚠ NO MECHANICS in Turboly (cannot create a Work Order): ${mechEmpty.join(', ')}`);
if (mechFailed.length) console.log(`  ⚠ mechanic lookup FAILED (stale flags kept, retry next run): ${mechFailed.join(', ')}`);

// ── 3+4. vehicle makes + models (/vehicles/new) ──────────────────────────
await page.goto(`${base}/vehicles/new`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const makes = await readPoll('#vehicle-make-select', 20);
if (makes.length > 10) {
  await getDb().collection('vehicle_makes').updateOne({ _id: 'makes' }, { $set: { list: [...new Set(makes.map((m) => m.t))], syncedAt: now } }, { upsert: true });
  const byMake = {};
  for (const mk of makes) {
    try {
      // Models come from a paginated JSON lookup (same one the select2 uses).
      const harvested = await page.evaluate(async (makeId) => {
        const out = [];
        // The endpoint serves 30 per page NO MATTER what page_limit asks for,
        // so "fewer than requested" fires after page one and silently cut
        // every big make to its first 30 (HONDA lost all its cars — the bikes
        // happen to fill page 1). The only stop conditions the server actually
        // honours are an empty page and repetition.
        const seen = new Set();
        for (let pg = 1; pg <= 40; pg++) {
          const r = await fetch(`/lookup/vehicle_models?search_term=&vehicle_type=&vehicle_make=${makeId}&page=${pg}&page_limit=100`, { headers: { accept: 'application/json' } });
          if (!r.ok) break;
          const j = await r.json();
          const list = (j.vehicle_models ?? []).map((m) => m.name).filter((n) => n && !seen.has(n));
          if (list.length === 0) break; // empty or pure repeats = past the end
          for (const n of list) seen.add(n);
          out.push(...list);
        }
        return out;
      }, mk.v);
      // Four names exist TWICE in the tenant's make table (HONDA/BMW/SUZUKI/
      // BAJAJ — the car brand and the bike brand as separate rows). Keyed by
      // name, the second row used to OVERWRITE the first — which is exactly
      // how HONDA's cars vanished behind its motorcycles. Union, never replace.
      byMake[mk.t] = [...new Set([...(byMake[mk.t] ?? []), ...harvested])];
    } catch { byMake[mk.t] = byMake[mk.t] ?? []; }
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
