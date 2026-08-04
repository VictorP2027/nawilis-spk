// Burst load test: N concurrent SPK submissions → measure API accept latency,
// then poll Mongo until the whole batch is confirmed in Turboly (or fails).
//
//   node --env-file=.env scripts/load-test.mjs           # N=30
//   node --env-file=.env scripts/load-test.mjs 10        # custom N
//
// Profiles are clearly marked (LOADTEST xx, plates B10xxLT, phones 081355500xx)
// for later cleanup. Branch NWL-BKS, service SPOORING (proven SKU).
import { MongoClient } from 'mongodb';

const N = Number(process.argv[2] || 30);
const BASE = process.env.LOADTEST_BASE ?? 'https://nawilis-spk.vercel.app';
// No default: a literal here ends up in git history, and history is public the
// moment the repo is.
const PASSWORD = process.env.STAFF_PASSWORD ?? '';

// ── login ────────────────────────────────────────────────────────────────
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
if (!cookie) { console.error('login failed'); process.exit(1); }

// ── fire N concurrent submissions ────────────────────────────────────────
const pad = (i) => String(i).padStart(2, '0');
const t0 = Date.now();
console.log(`T+0s  firing ${N} concurrent submissions…`);
const results = await Promise.all(
  Array.from({ length: N }, (_, k) => {
    const i = k + 1;
    const body = {
      uploadId: `loadtest-${t0}-${pad(i)}`,
      docType: 'SPK_NAWILIS',
      branchCode: 'NWL-BKS',
      captureMode: 'typed',
      operatorUserId: 'loadtest',
      operatorPinVerified: true,
      deviceBindingVerified: true,
      capturedAt: new Date().toISOString(),
      customer: { nama: `LOADTEST ${pad(i)}`, wa: `081355500${pad(i)}`, alamat: 'JL LOADTEST 1' },
      vehicle: { noPolisi: `B10${pad(i)}LT`, merk: 'Toyota', tipe: 'ALL NEW AVANZA', tahun: 2020, warna: 'Silver', km: '20000' },
      complaint: `load test profile ${pad(i)}`,
      jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1 }],
      signatures: { menyerahkanPresent: false, menerimaPresent: false },
    };
    const sent = Date.now();
    return fetch(`${BASE}/api/spk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
      .then(async (r) => ({ i, ok: r.ok, ms: Date.now() - sent, id: (await r.json().catch(() => ({}))).spkId ?? null }))
      .catch((e) => ({ i, ok: false, ms: Date.now() - sent, id: null, err: String(e) }));
  }),
);
const okd = results.filter((r) => r.ok && r.id);
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
console.log(`submit: ${okd.length}/${N} accepted | API latency min/med/max = ${lat[0]}/${lat[Math.floor(lat.length / 2)]}/${lat[lat.length - 1]} ms | wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!okd.length) process.exit(1);
const ids = okd.map((r) => r.id);

// ── poll Mongo until drained ─────────────────────────────────────────────
const mc = new MongoClient(process.env.MONGODB_URI);
await mc.connect();
const spk = mc.db(process.env.MONGODB_DB || 'spk').collection('spk');
const doneAt = new Map(); // id → ms from t0 when first seen confirmed/failed
const DEADLINE = 90 * 60_000;
for (;;) {
  const docs = await spk.find({ _id: { $in: ids } }, { projection: { state: 1, 'turboly.serviceOrderNo': 1 } }).toArray();
  const hist = {};
  for (const d of docs) {
    hist[d.state] = (hist[d.state] ?? 0) + 1;
    if ((d.state === 'confirmed' || d.state === 'failed') && !doneAt.has(String(d._id))) doneAt.set(String(d._id), Date.now() - t0);
  }
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(`T+${el}s  ${Object.entries(hist).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  const pending = docs.filter((d) => !['confirmed', 'failed'].includes(d.state)).length;
  if (pending === 0 || Date.now() - t0 > DEADLINE) break;
  await new Promise((r) => setTimeout(r, 20_000));
}

// ── stats ────────────────────────────────────────────────────────────────
const finals = await spk.find({ _id: { $in: ids } }, { projection: { state: 1, 'turboly.serviceOrderNo': 1, 'push.attempt': 1 } }).toArray();
const confirmed = finals.filter((d) => d.state === 'confirmed');
const failed = finals.filter((d) => d.state === 'failed');
const times = [...doneAt.values()].sort((a, b) => a - b);
const mins = (ms) => (ms / 60000).toFixed(1);
console.log('\n════════ HASIL LOAD TEST ════════');
console.log(`profil: ${N}  | confirmed: ${confirmed.length}  | failed: ${failed.length}  | belum selesai: ${N - confirmed.length - failed.length}`);
if (times.length) {
  console.log(`SO pertama selesai: ${mins(times[0])} menit  | median: ${mins(times[Math.floor(times.length / 2)])} menit  | terakhir: ${mins(times[times.length - 1])} menit`);
  console.log(`throughput: ${(times.length / (times[times.length - 1] / 60000)).toFixed(1)} SO/menit`);
}
for (const f of failed) console.log(`  ✗ ${f._id} attempt=${f.push?.attempt}`);
await mc.close();
