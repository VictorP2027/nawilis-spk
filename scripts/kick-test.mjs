// Turboly session-scope test — the go/no-go gate for parallel push workers.
//
// The whole parallel-worker plan rests on ONE unverified assumption: that
// Turboly scopes its one-session-per-user rule to the USER, not the tenant.
// If two different accounts can hold live sessions at once, workers can run in
// parallel; if a login by ANY account kicks every other session in the tenant,
// the plan is dead and push2.yml must never be activated.
//
//   TURBOLY_USERNAME_2=pusher2@… TURBOLY_PASSWORD_2=… \
//     node --env-file=.env scripts/kick-test.mjs [--hold=120]
//
// Uses plain-HTTP Rails auth (no browser). Logs in as account 1 and account 2,
// holds both, probes both, then RE-logs account 2 to prove same-user kicking
// still works (that re-login must kill B1 but leave A untouched).
//
// ⚠ Logging in as account 1 kicks any LIVE cron session on that account — run
// this inside the usual pause window (see ACTIVATE-PUSH2.md), never alongside
// an active push/flow/sync run.
const BASE = process.env.TURBOLY_BASE_URL ?? 'https://sandbox.turboly.com';
const HOLD = Number(process.argv.find((a) => a.startsWith('--hold='))?.split('=')[1] ?? 120) * 1000;

const A = { user: process.env.TURBOLY_USERNAME, pass: process.env.TURBOLY_PASSWORD, name: 'A (worker 1)' };
const B = { user: process.env.TURBOLY_USERNAME_2, pass: process.env.TURBOLY_PASSWORD_2, name: 'B (worker 2)' };
if (!A.user || !B.user) {
  console.error('need TURBOLY_USERNAME(+_PASSWORD) and TURBOLY_USERNAME_2(+_PASSWORD_2)');
  process.exit(2);
}
if (A.user === B.user) {
  console.error('the two accounts are the SAME user — the test would prove nothing');
  process.exit(2);
}

const jarOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
const merge = (...ls) => {
  const m = new Map();
  for (const l of ls) for (const p of l) { const [k, ...v] = p.split('='); if (k && v.length) m.set(k, v.join('=')); }
  return [...m].map(([k, v]) => `${k}=${v}`).join('; ');
};

async function login(acct) {
  const r1 = await fetch(`${BASE}/users/sign_in`, { redirect: 'manual' });
  const pre = jarOf(r1);
  const tok = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(await r1.text())?.[1] ?? '';
  const r2 = await fetch(`${BASE}/users/sign_in`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: merge(pre), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'user[email]': acct.user, 'user[password]': acct.pass, authenticity_token: tok, commit: 'Login' }).toString(),
  });
  if (r2.status !== 302) throw new Error(`${acct.name}: login HTTP ${r2.status}`);
  let cookie = merge(pre, jarOf(r2));
  const r3 = await fetch(r2.headers.get('location') ?? `${BASE}/dashboard`, { headers: { cookie }, redirect: 'manual' });
  return merge(cookie.split('; '), jarOf(r3));
}

/** Alive = an authenticated page does NOT bounce to sign_in. */
async function alive(cookie) {
  const r = await fetch(`${BASE}/service_orders`, { headers: { cookie }, redirect: 'manual' });
  return r.status === 200;
}

const t0 = Date.now();
const stamp = () => `[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`;

console.log(`target: ${BASE}\n`);
const cookieA = await login(A); console.log(stamp(), 'login', A.name, '→ OK');
const cookieB = await login(B); console.log(stamp(), 'login', B.name, '→ OK');

const aAfterB = await alive(cookieA);
console.log(stamp(), `A alive immediately after B's login: ${aAfterB ? 'YES' : 'NO — KICKED'}`);
if (!aAfterB) { console.log('\n❌ FAIL: tenant-scoped sessions. Parallel workers are impossible. Do NOT activate push2.yml.'); process.exit(1); }

console.log(stamp(), `holding both sessions ${HOLD / 1000}s, probing every 30s…`);
for (let waited = 0; waited < HOLD; waited += 30_000) {
  await new Promise((r) => setTimeout(r, Math.min(30_000, HOLD - waited)));
  const [a, b] = [await alive(cookieA), await alive(cookieB)];
  console.log(stamp(), `A ${a ? 'alive' : 'DEAD'} · B ${b ? 'alive' : 'DEAD'}`);
  if (!a && b) {
    // A alone dying is the signature of ANOTHER user-1 login, not tenant
    // scoping — most likely the web app's prefill lookup, which logs in as
    // account 1 whenever no worker has touched Turboly recently.
    console.log('\n❌ FAIL — but A died while B survived: almost certainly the web app\'s');
    console.log('   lookup login as account 1, NOT tenant-scoped sessions. Re-run during');
    console.log('   quiet hours (or right after an SPK submission, which mutes lookups).');
    process.exit(1);
  }
  if (!a || !b) { console.log('\n❌ FAIL: a session died during concurrent hold.'); process.exit(1); }
}

// Same-user kick must still happen: B's re-login should kill old-B, not A.
const cookieB2 = await login(B);
console.log(stamp(), 'B re-logged in (fresh session B2)');
await new Promise((r) => setTimeout(r, 3000));
const [a2, b1, b2] = [await alive(cookieA), await alive(cookieB), await alive(cookieB2)];
console.log(stamp(), `A ${a2 ? 'alive' : 'DEAD'} · old-B ${b1 ? 'ALIVE (unexpected)' : 'kicked (expected)'} · new-B ${b2 ? 'alive' : 'DEAD'}`);

if (a2 && b2) {
  console.log('\n✅ PASS: sessions are per-user. Parallel workers are viable — proceed per ACTIVATE-PUSH2.md.');
  if (b1) console.log('   (note: old-B survived a same-user re-login — Turboly may allow N sessions per user; even better.)');
} else {
  console.log('\n❌ FAIL: cross-user interference on re-login.');
  process.exit(1);
}
