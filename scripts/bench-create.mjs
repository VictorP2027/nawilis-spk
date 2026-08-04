// bench-create — where the wall clock between "job enqueued" and "customer
// exists in Turboly" actually goes.
//
//   node --env-file=.env scripts/bench-create.mjs [--days=14] [--runs=15]
//
// Touches NOTHING in Turboly: one session per user, and a live job may be
// running. Every number here is reconstructed from timestamps the pipeline
// already wrote (flow_jobs, spk, spk_events) plus the GitHub Actions API.
//
// The reading that matters most: a flow job's createdAt→startedAt is NOT idle
// queue time. The worker does not exist until GitHub has booted a runner, so
// that single gap already contains the repository_dispatch wait, the
// turboly-push concurrency queue, and the whole checkout / npm ci / Playwright
// download / build cold start. Even with no GH token this script can say
// whether the cost is "getting a worker" or "the worker's own work".
import { MongoClient } from 'mongodb';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const DAYS = arg('days', 14);
const RUNS = arg('runs', 15);
const GOAL_S = 10; // the owner's target: "registering a customer should be 10 seconds"
const REPO = process.env.GITHUB_REPOSITORY ?? 'VictorP2027/nawilis-spk';
// The step that runs the worker itself — everything above it in the job is cold start.
const WORKER_STEP = { 'flow.yml': /^Drain flow jobs/i, 'push.yml': /^Push queued SPKs/i };

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

// Timestamps come from three clocks (Vercel writes createdAt, the runner writes
// startedAt/finishedAt, GitHub writes its own): small negative gaps are skew,
// not information, so they are dropped rather than clamped to zero.
const at = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN);
const gap = (a, b) => {
  const x = at(a);
  const y = at(b);
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
};
const keep = (xs) => xs.filter((v) => v != null);
const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const secs = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)}s`);
const dec = (v, d = 1) => (v == null ? '—' : v.toFixed(d));

const durRow = (label, xs) => [label, xs.length, secs(pct(xs, 0.5)), secs(pct(xs, 0.9)), secs(max(xs))];
const cntRow = (label, xs) => [label, xs.length, dec(pct(xs, 0.5)), dec(pct(xs, 0.9)), dec(max(xs), 0)];

function table(rows, head = ['metric', 'n', 'p50', 'p90', 'worst']) {
  const all = [head, ...rows].map((r) => r.map(String));
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all.map((r) => '  ' + r.map((c, i) => (i === 0 ? c.padEnd(w[0]) : c.padStart(w[i]))).join('  ').trimEnd()).join('\n');
}

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI kosong — jalankan dengan: node --env-file=.env scripts/bench-create.mjs');
  process.exit(1);
}

const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db(process.env.MONGODB_DB || 'spk');

console.log(`bench-create — window: last ${DAYS}d (since ${since.slice(0, 16)}Z), repo ${REPO}`);
console.log('no Turboly calls; all timings reconstructed from stored timestamps\n');

// 1) flow_jobs — the customer-registration path the owner actually complains about.
// A transient failure re-queues the SAME job and the next claim OVERWRITES
// startedAt, so execution below is only the LAST attempt; the attempts row is
// what exposes the restarts, and createdAt→finishedAt is what he experiences.
const jobs = await db
  .collection('flow_jobs')
  .find({ action: { $regex: '^register_customer' }, createdAt: { $gte: since } })
  .toArray();

const doneJobs = jobs.filter((j) => j.state === 'done');
const failedJobs = jobs.filter((j) => j.state === 'failed');
const openJobs = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
const jobQueue = keep(doneJobs.map((j) => gap(j.createdAt, j.startedAt)));
const jobExec = keep(doneJobs.map((j) => gap(j.startedAt, j.finishedAt)));
const jobE2e = keep(doneJobs.map((j) => gap(j.createdAt, j.finishedAt)));
const jobAttempts = doneJobs.map((j) => j.attempts ?? 1);

console.log(`FLOW JOBS register_customer_*  —  ${doneJobs.length} done, ${failedJobs.length} failed, ${openJobs.length} still open`);
if (doneJobs.length) {
  console.log(
    table([
      durRow('queue wait   created→started (= dispatch + runner boot)', jobQueue),
      durRow('execution    started→finished (last attempt only)', jobExec),
      durRow('END-TO-END   created→finished', jobE2e),
      cntRow('attempts per success (each extra = full restart)', jobAttempts),
    ]),
  );
} else {
  console.log('  (no completed registrations in the window — widen with --days=)');
}
console.log('');

// 2) spk pushes. The Actions path (pushRunner) records far less than the old
// BullMQ worker did: it never writes push.claimedAt or push.phases.order.at, so
// for most docs the only honest markers are assignment.assignedAt (the exact
// moment the doc became pushable) and updatedAt. updatedAt is reused by later
// flow-board writes, so docs that moved on through the flow are excluded from
// the end-to-end row instead of silently reporting hours.
const docs = await db
  .collection('spk')
  .find(
    { state: { $in: ['pushed', 'confirmed'] }, updatedAt: { $gte: since } },
    { projection: { assignment: 1, push: 1, flow: 1, createdAt: 1, updatedAt: 1 } },
  )
  .toArray();

const pushedEventAt = new Map();
if (docs.length) {
  const evts = await db
    .collection('spk_events')
    .find({ spkId: { $in: docs.map((d) => d._id) }, type: { $in: ['pushed', 'confirmed'] } }, { projection: { spkId: 1, at: 1 } })
    .toArray();
  for (const e of evts) {
    const cur = pushedEventAt.get(e.spkId);
    if (!cur || String(e.at) < String(cur)) pushedEventAt.set(e.spkId, e.at);
  }
}

const soExistsAt = (d) => pushedEventAt.get(d._id) ?? d.push?.phases?.order?.at ?? (d.flow ? null : d.updatedAt);
const withAssign = docs.filter((d) => d.assignment?.assignedAt);
const spkE2e = keep(withAssign.map((d) => gap(d.assignment.assignedAt, soExistsAt(d))));
const spkClaimWait = keep(withAssign.map((d) => gap(d.assignment.assignedAt, d.push?.claimedAt)));
const spkExec = keep(docs.map((d) => gap(d.push?.claimedAt, soExistsAt(d))));
const spkAttempts = docs.map((d) => d.push?.attempt ?? 0).filter((n) => n > 0);

console.log(`SPK PUSH pushed/confirmed  —  ${docs.length} docs, ${withAssign.length} with assignment.assignedAt`);
if (docs.length) {
  console.log(
    table([
      durRow('END-TO-END   assigned→SO exists', spkE2e),
      durRow('queue wait   assigned→push.claimedAt', spkClaimWait),
      durRow('execution    claimedAt→SO exists', spkExec),
      cntRow('push.attempt per success', spkAttempts),
    ]),
  );
  if (!spkClaimWait.length) console.log('  note: push.claimedAt is written only by the old BullMQ worker — the Actions pusher leaves it empty, so the split is unavailable');
} else {
  console.log('  (no pushed/confirmed SPKs in the window)');
}
console.log('');

// 3) GitHub Actions. Optional by design: with no token the flow-job queue wait
// above still carries the same cost, just unattributed.
const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const gh = {};
async function ghGet(path) {
  try {
    const r = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // a network hiccup must not lose the Mongo half of the report
  }
}

if (!ghToken) {
  console.log('GITHUB ACTIONS — skipped (no GH_TOKEN/GITHUB_TOKEN). The cold start is still inside "queue wait" above.\n');
} else {
  for (const wf of ['flow.yml', 'push.yml']) {
    const list = await ghGet(`/repos/${REPO}/actions/workflows/${wf}/runs?per_page=${RUNS}&status=completed`);
    if (!list?.workflow_runs?.length) {
      console.log(`GITHUB ACTIONS ${wf} — no data (token lacks actions:read, or no completed runs)\n`);
      continue;
    }
    const runnerWait = [];
    const coldStart = [];
    const workStep = [];
    const setup = new Map();
    for (const run of list.workflow_runs) {
      const jr = await ghGet(`/repos/${REPO}/actions/runs/${run.id}/jobs`);
      const job = jr?.jobs?.find((j) => j.steps?.some((s) => WORKER_STEP[wf].test(s.name ?? '')));
      if (!job) continue;
      const step = job.steps.find((s) => WORKER_STEP[wf].test(s.name));
      if (!step?.started_at) continue; // cancelled/skipped before the worker ever ran
      // created_at (not run_started_at): a repository_dispatch run that waits on
      // the shared turboly-push concurrency group is exactly the delay staff feel.
      const w = gap(run.created_at, job.started_at);
      const cold = gap(job.started_at, step.started_at);
      const work = gap(step.started_at, step.completed_at);
      if (w != null) runnerWait.push(w);
      if (cold != null) coldStart.push(cold);
      if (work != null) workStep.push(work);
      for (const s of job.steps) {
        if (at(s.started_at) >= at(step.started_at)) continue;
        const d = gap(s.started_at, s.completed_at);
        if (d == null) continue;
        setup.set(s.name, [...(setup.get(s.name) ?? []), d]);
      }
    }
    gh[wf] = { runnerWait, coldStart, workStep };
    console.log(`GITHUB ACTIONS ${wf}  —  ${coldStart.length} runs sampled`);
    console.log(
      table([
        durRow('wait for runner  run created→job start (incl. turboly-push queue)', runnerWait),
        durRow('COLD START       job start→worker step (checkout/npm ci/chromium/build)', coldStart),
        durRow('worker step      duration (includes empty passes)', workStep),
      ]),
    );
    const top = [...setup.entries()]
      .map(([n, xs]) => [n, pct(xs, 0.5)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (top.length) console.log(`  cold start is: ${top.map(([n, v]) => `${n} ${secs(v)}`).join(' · ')}`);
    console.log('');
  }
}

// 4) Verdict. Compare only slices that actually compose one wall clock, so the
// answer is "kill this one first" rather than a wall of numbers.
const flowGh = gh['flow.yml'];
const coldP50 = pct(flowGh?.coldStart ?? [], 0.5);
const waitP50 = pct(flowGh?.runnerWait ?? [], 0.5);
const execP50 = pct(jobExec, 0.5) ?? pct(flowGh?.workStep ?? [], 0.5);
const e2eP50 = pct(jobE2e, 0.5);
const meanAttempts = mean(jobAttempts);
// One restart costs a whole fresh cycle: the runner is gone and pays cold start again.
const cycle = (coldP50 ?? pct(jobQueue, 0.5) ?? 0) + (execP50 ?? 0);
const restartCost = meanAttempts && meanAttempts > 1 ? (meanAttempts - 1) * cycle : null;

// Only MEASURED slices compete for "biggest": restartCost is modelled from the
// other two, so letting it win would just point back at them.
const contributors = [
  ['runner cold start (checkout + npm ci + chromium + build)', coldP50],
  ['waiting for a runner / turboly-push concurrency queue', waitP50],
  ['worker execution (login + Turboly forms)', execP50],
].filter(([, v]) => v != null && v > 0);
// With no GH token the queue wait is unattributed but still measured, and it is
// usually the biggest number on the page — say so rather than stay silent.
if (!flowGh && pct(jobQueue, 0.5) != null) contributors.push(['getting a worker at all (dispatch + runner boot + setup)', pct(jobQueue, 0.5)]);

if (contributors.length) {
  const [name, v] = contributors.sort((a, b) => b[1] - a[1])[0];
  const overBy = e2eP50 ? ` — p50 end-to-end ${secs(e2eP50)} vs goal ${GOAL_S}s (${(e2eP50 / 1000 / GOAL_S).toFixed(1)}× over)` : '';
  const retries = restartCost ? `; retries multiply it (mean ${dec(meanAttempts, 2)} attempts/success ≈ +${secs(restartCost)})` : '';
  console.log(`VERDICT: biggest contributor = ${name}, ~${secs(v)} at p50${overBy}${retries}`);
} else {
  console.log('VERDICT: not enough data — widen the window (--days=) or add GH_TOKEN for runner timings');
}

await c.close();
