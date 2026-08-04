// Pipeline monitor — alerts on failed or stuck pushes.
//
//   node --env-file=.env scripts/monitor.mjs
//
// Checks the spk collection for:
//   1. FAILED pushes not yet alerted (or failed AGAIN after a retry)
//   2. STUCK records: queued/pushing with no movement for > 25 minutes
// Prints a report, marks each doc as alerted (so one problem = one alert, not
// an email every 15 minutes), and exits 1 when anything NEW is found — in CI
// that failure makes GitHub send the repo owner a notification email.
import { MongoClient } from 'mongodb';

const STUCK_MIN = 25;
const ADMIN_URL = 'https://nawilis-spk.vercel.app/admin';

const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db(process.env.MONGODB_DB || 'spk');
const spk = db.collection('spk');
const now = new Date();
const nowIso = now.toISOString();

const label = (d) =>
  `${d._id}  ${d.customer?.nama || '(tanpa nama)'}  ${d.vehicle?.noPolisi?.full || '-'}  cabang=${d.branchCode ?? d.branch?.code ?? '-'}`;

// 1) Failed pushes — alert once per failure "generation": a doc retried by the
// admin and failed again has updatedAt > alertedAt, so it re-alerts.
const failed = await spk
  .find({ state: 'failed' }, { projection: { customer: 1, vehicle: 1, branchCode: 1, branch: 1, push: 1, updatedAt: 1 } })
  .toArray();
const newFailed = failed.filter((d) => !d.push?.alertedAt || d.push.alertedAt < d.updatedAt);

// 2) Stuck in queued/pushing — nothing should sit there for 25+ minutes
// (cron runs every 5, transient retries requeue quickly).
const stuckCutoff = new Date(now.getTime() - STUCK_MIN * 60_000).toISOString();
const stuck = await spk
  .find(
    { state: { $in: ['queued', 'pushing'] }, updatedAt: { $lt: stuckCutoff } },
    { projection: { customer: 1, vehicle: 1, branchCode: 1, branch: 1, push: 1, state: 1, updatedAt: 1 } },
  )
  .toArray();
const newStuck = stuck.filter((d) => !d.push?.stuckAlertedAt || d.push.stuckAlertedAt < d.updatedAt);

const lines = [];

// 0) SAFETY NET: a DISABLED workflow looks exactly like silence — records just
// sit queued forever with nobody to push them. Alert loudly (needs GH_TOKEN,
// which Actions provides automatically as github.token).
const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY ?? 'VictorP2027/nawilis-spk';
if (ghToken) {
  for (const wf of ['push.yml', 'flow.yml']) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}`, {
        headers: { authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github+json' },
      });
      if (r.ok) {
        const j = await r.json();
        if (j.state && j.state !== 'active') lines.push(`## ⛔ WORKFLOW ${wf} = ${j.state} — SPK tidak akan terkirim sampai di-enable!`);
      }
    } catch { /* network hiccup — the record checks below still run */ }
  }
}
if (newFailed.length) {
  lines.push(`## ❌ ${newFailed.length} push GAGAL`);
  for (const d of newFailed) {
    lines.push(`- ${label(d)}`);
    lines.push(`  - error: ${d.push?.lastError ?? '?'} (${d.push?.failureClass ?? '?'}, attempt ${d.push?.attempt ?? '?'})`);
  }
}
if (newStuck.length) {
  lines.push(`## ⏳ ${newStuck.length} MACET di ${STUCK_MIN}+ menit (queued/pushing tidak bergerak)`);
  for (const d of newStuck) lines.push(`- ${label(d)}  state=${d.state} sejak ${d.updatedAt}`);
}

if (lines.length) {
  lines.push('', `→ Buka admin: ${ADMIN_URL} (tombol "↻ Coba lagi" untuk retry)`);
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  }
  // Mark as alerted so the next run is green until something NEW breaks.
  if (newFailed.length)
    await spk.updateMany({ _id: { $in: newFailed.map((d) => d._id) } }, { $set: { 'push.alertedAt': nowIso } });
  if (newStuck.length)
    await spk.updateMany({ _id: { $in: newStuck.map((d) => d._id) } }, { $set: { 'push.stuckAlertedAt': nowIso } });
  await c.close();
  process.exit(1);
}

console.log(`OK — tidak ada push gagal/macet baru (failed total: ${failed.length}, stuck total: ${stuck.length})`);
await c.close();
