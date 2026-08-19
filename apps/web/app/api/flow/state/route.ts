import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  collections, flowJobs, effectiveFlow, boardColumn, stageLabel, nextFlowAction,
  canRunFlowAction, isFlowAction,
  FLOW_ACTION_LABELS, FLOW_BOARD_COLUMNS, FLOW_BOARD_LABELS,
  type FlowJob, type FlowState, type SpkDoc,
} from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/flow/state[?branch=NWL-BKS] — everything the flow board needs in one
 * poll (the board calls this every ~10s):
 *
 *   columns  static column ids + Indonesian labels (Intake … Selesai)
 *   rows     active SPK + Check&Go cards: identity, current Turboly doc numbers,
 *            derived board column + the ONE primary next action, plus the card's
 *            in-flight job (spinner) or newest failed job (error + retry)
 *   jobs     raw open flow_jobs (queued/running/failed) + just-finished ones,
 *            newest first — for the board's activity strip / registration jobs
 *            that aren't bound to a doc (spkId '').
 */

const ACTIVE_WINDOW_MS = 14 * 24 * 3600 * 1000; // in-progress cards: keep 14 days
const DONE_WINDOW_MS = 24 * 3600 * 1000; // finished cards linger 24h in "Selesai"
const RECENT_DONE_JOBS_MS = 15 * 60 * 1000; // just-finished jobs, for success flashes

type BoardDoc = SpkDoc & {
  flow?: FlowState | null;
  checkGo?: { harga?: number | null; inspectionItems?: unknown[] | null } | null;
};

interface JobBrief {
  jobId: string;
  spkId: string;
  action: string;
  state: string;
  attempts: number;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
}

function brief(j: FlowJob): JobBrief {
  return {
    jobId: j._id,
    spkId: j.spkId,
    action: String(j.action),
    state: j.state,
    attempts: j.attempts,
    error: j.error ?? null,
    result: j.result ?? null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt ?? null,
  };
}

export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const branch = url.searchParams.get('branch');
  const now = Date.now();
  const activeSince = new Date(now - ACTIVE_WINDOW_MS).toISOString();
  const doneSince = new Date(now - DONE_WINDOW_MS).toISOString();

  // Active docs: everything not yet invoiced (within the window) + freshly
  // finished ones (so cards visibly land in "Selesai" before dropping off).
  const q: Record<string, unknown> = {
    state: { $nin: ['voided', 'superseded'] },
    // Dead-end cards someone took off the board on purpose. Separate from
    // `state` because these docs are still legitimately `confirmed` in Turboly.
    'flow.archived': { $ne: true },
    $or: [
      { 'flow.invoice': { $ne: 'completed' }, createdAt: { $gte: activeSince } },
      { 'flow.invoice': 'completed', updatedAt: { $gte: doneSince } },
    ],
  };
  if (branch) q.branchCode = branch;

  const docs = (await collections
    .spk()
    .find(q, {
      projection: {
        docType: 1, branchCode: 1, nomorAntrian: 1, state: 1,
        'customer.nama': 1, 'customer.waE164': 1,
        'vehicle.noPolisi': 1, 'vehicle.km': 1, 'vehicle.merkNormalized': 1, 'vehicle.tipeNormalized': 1,
        jobLineSummary: 1, estimasi: 1, scheduledAt: 1,
        flow: 1,
        // NOT the whole turboly / checkGo subtrees. This response is re-fetched
        // every 10 seconds by every open board, so anything projected here is
        // paid for again six times a minute, forever. Measured before trimming:
        // 84.9 KB for 32 cards, of which checkGo.report (16 KB) and
        // checkGo.inspectionItems (27.6 KB) were 52% — and the board reads
        // NEITHER, only checkGo.alert.mode. Same for turboly, where the card
        // shows four document numbers and the read-back blob rode along.
        'turboly.serviceOrderNo': 1, 'turboly.serviceOrderUrl': 1, 'turboly.workOrderNo': 1, 'turboly.mergedInto': 1,
        'checkGo.alert': 1, 'checkGo.harga': 1,
        'push.lastError': 1, 'push.failureClass': 1,
        createdAt: 1, updatedAt: 1,
      },
      sort: { createdAt: -1 },
      limit: 300,
    })
    .toArray()) as BoardDoc[];

  // Open jobs + recently finished ones, newest first.
  const jobs = await flowJobs()
    .find(
      {
        $or: [
          { state: { $in: ['queued', 'running', 'failed'] } },
          { state: 'done', updatedAt: { $gte: new Date(now - RECENT_DONE_JOBS_MS).toISOString() } },
        ],
      },
      { sort: { createdAt: -1 }, limit: 400 },
    )
    .toArray();

  const jobsBySpk = new Map<string, FlowJob[]>();
  for (const j of jobs) {
    if (!j.spkId) continue;
    const list = jobsBySpk.get(j.spkId);
    if (list) list.push(j);
    else jobsBySpk.set(j.spkId, [j]);
  }

  const rows = docs.map((d) => {
    const f = effectiveFlow(d);
    // effectiveFlow falls back to initFlow(), which stamps updatedAt with the
    // CURRENT time — so a card that has never reached the board would report a
    // brand-new timestamp on every poll. That is both untrue (nothing changed)
    // and expensive: it made every response byte-different, so the ETag below
    // could never match and no poll could ever answer 304. When there is no
    // stored flow, the moment the document itself last changed is the honest
    // answer and a stable one.
    f.updatedAt = d.flow?.updatedAt ?? d.updatedAt;
    const docJobs = jobsBySpk.get(d._id) ?? []; // newest first (query sort)
    const activeJob = docJobs.find((j) => j.state === 'queued' || j.state === 'running') ?? null;
    // A failed job row is permanent, so without this it haunts the card long
    // after a later job did the work: SWO/CPT/26080019 sat in_progress while
    // still showing "Buat Work Order gagal" + a live [Coba lagi] from an
    // attempt two jobs earlier. And because the card suppresses its
    // next-action button whenever a failure is displayed, that dead error
    // STRANDED the doc — staff could not advance it from the board at all.
    // So only surface a failure the flow could still legally act on; once the
    // step's outcome exists, retrying it is a lie. A genuine failure keeps its
    // precondition (create_wo with no WO yet), so it still shows.
    const failedJob = activeJob
      ? null
      : docJobs.find((j) => j.state === 'failed' && (!isFlowAction(j.action) || canRunFlowAction(f, j.action))) ?? null;
    // While a job is in flight the card shows a spinner, not a second button.
    const next = activeJob ? null : nextFlowAction(f);
    const isCheckGo = String(d.docType) === 'CHECK_AND_GO';
    const pushBlocked = d.state === 'failed' || d.state === 'manual_intervention';
    // Lines appended onto the same car's Check & Go order: this card has no
    // order of its own and no steps to offer — its work is that card's work.
    const mergedInto = d.turboly?.mergedInto ?? null;

    return {
      spkId: d._id,
      docType: String(d.docType),
      typeBadge: isCheckGo ? 'C&G' : 'SPK',
      branchCode: d.branchCode,
      nomorAntrian: d.nomorAntrian ?? null,
      customer: { nama: d.customer?.nama ?? '', wa: d.customer?.waE164 ?? null },
      plate: d.vehicle?.noPolisi?.display || d.vehicle?.noPolisi?.full || '',
      vehicleLabel: [d.vehicle?.merkNormalized, d.vehicle?.tipeNormalized].filter(Boolean).join(' ') || null,
      km: d.vehicle?.km?.value ?? null,
      quotedTotal: d.jobLineSummary?.quotedTotal ?? 0,
      estimasiMinutes: d.estimasi?.minutes ?? null,
      scheduledAt: d.scheduledAt ?? null,

      state: d.state,
      /** Intake-column push problem (red): the push pipeline needs attention. */
      pushError: pushBlocked ? d.push?.lastError ?? null : null,

      flow: f,
      turboly: {
        serviceOrderNo: d.turboly?.serviceOrderNo ?? null,
        // A merged SPK links to the Check & Go's order so the card still opens the right page.
        serviceOrderUrl: d.turboly?.serviceOrderUrl ?? mergedInto?.serviceOrderUrl ?? null,
        workOrderNo: f.workOrderNo ?? d.turboly?.workOrderNo ?? null,
        invoiceNo: f.invoiceNo ?? null,
      },
      mergedInto,

      column: mergedInto ? 'done' : boardColumn(f),
      stageLabel: mergedInto
        ? `Digabung ke SO ${mergedInto.serviceOrderNo ?? ''} (${String(d.docType) === 'CHECK_AND_GO' ? 'SPK' : 'Check & Go'})`.trim()
        : stageLabel(f),
      nextAction: mergedInto ? null : next,
      nextActionLabel: !mergedInto && next ? FLOW_ACTION_LABELS[next] : null,

      checkGo: d.checkGo ?? null,

      activeJob: activeJob ? brief(activeJob) : null,
      failedJob: failedJob ? brief(failedJob) : null,

      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });

  const payload = {
    columns: FLOW_BOARD_COLUMNS.map((c) => ({ id: c, label: FLOW_BOARD_LABELS[c] })),
    rows,
    jobs: jobs.map(brief),
  };

  // Most polls find nothing changed — a workshop does not move a card every ten
  // seconds — so the honest answer to most of them is "same as before". The
  // ETag is computed over the payload WITHOUT `now`, because a timestamp that
  // ticks every request would make every response look new and defeat the whole
  // mechanism. A 304 carries no body, which is what keeps an all-day board from
  // costing megabytes an hour in origin transfer.
  const etag = `W/"${createHash('sha1').update(JSON.stringify(payload)).digest('base64url')}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
  }
  return NextResponse.json(
    { now: new Date().toISOString(), ...payload },
    { headers: { ETag: etag, 'Cache-Control': 'no-cache' } },
  );
}
