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
        flow: 1, turboly: 1, checkGo: 1,
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
        serviceOrderUrl: d.turboly?.serviceOrderUrl ?? null,
        workOrderNo: f.workOrderNo ?? d.turboly?.workOrderNo ?? null,
        invoiceNo: f.invoiceNo ?? null,
      },

      column: boardColumn(f),
      stageLabel: stageLabel(f),
      nextAction: next,
      nextActionLabel: next ? FLOW_ACTION_LABELS[next] : null,

      checkGo: d.checkGo ?? null,

      activeJob: activeJob ? brief(activeJob) : null,
      failedJob: failedJob ? brief(failedJob) : null,

      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });

  return NextResponse.json({
    now: new Date().toISOString(),
    columns: FLOW_BOARD_COLUMNS.map((c) => ({ id: c, label: FLOW_BOARD_LABELS[c] })),
    rows,
    jobs: jobs.map(brief),
  });
}
