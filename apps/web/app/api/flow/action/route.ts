import { NextResponse } from 'next/server';
import {
  collections, flowJobs, enqueueFlowJob, retryFlowJob, ensureFlowInitialized,
  effectiveFlow, canRunFlowAction, isFlowAction,
  FLOW_ACTIONS, FLOW_ACTION_LABELS,
  type FlowActionType,
} from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/flow/action — enqueue ONE Turboly lifecycle step for the flow board.
 *
 * Body: { spkId?, action, params?, by?, force? } or { retryJobId } to re-queue
 * a failed job. The route only QUEUES (insert into flow_jobs) and fires the
 * GitHub repository_dispatch [flow-action] so the flow worker runs immediately;
 * all Turboly RPA happens serially in apps/worker/src/flow-once.ts.
 *
 * Auth: the spk_auth cookie gate in middleware.ts (401 without it).
 */

/** Actions that are NOT bound to an existing document (customer registration). */
const DOCLESS_ACTIONS: readonly FlowActionType[] = ['register_customer_retail', 'register_customer_wholesale'];

/** Tolerated spellings from older/board clients → canonical action names. */
const ACTION_ALIASES: Record<string, FlowActionType> = {
  approve: 'approve_so',
  approveserviceorder: 'approve_so',
  buatworkorder: 'create_wo',
  createworkorder: 'create_wo',
  start: 'start_wo',
  startworkorder: 'start_wo',
  selesai: 'complete_wo',
  completeworkorder: 'complete_wo',
  qcapprove: 'qc_ok',
  buatinvoice: 'create_invoice',
  createinvoice: 'create_invoice',
  selesaikaninvoice: 'complete_invoice',
  completeinvoice: 'complete_invoice',
  fillinspections: 'fill_inspections',
  isiinspeksi: 'fill_inspections',
  tetapchecksaja: 'stay_check_only',
  registerretailcustomer: 'register_customer_retail',
  registerwholesalecustomer: 'register_customer_wholesale',
};

function normalizeAction(raw: unknown): FlowActionType | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (isFlowAction(s)) return s;
  const stripped = s.replace(/[^a-z]/g, '');
  for (const a of FLOW_ACTIONS) {
    if (a.replace(/[^a-z]/g, '') === stripped) return a;
  }
  return ACTION_ALIASES[stripped] ?? null;
}

/**
 * Fire the GitHub repository_dispatch that starts the flow workflow NOW instead
 * of waiting for its 5-min cron — same pattern (and the same env vars) as
 * lib/triggerPush.ts, but with event_type "flow-action" for flow.yml.
 * Best-effort and time-boxed: a GitHub hiccup must never fail the enqueue.
 */
async function triggerFlowRun(jobId: string, spkId: string, action: string): Promise<void> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return; // not configured (e.g. local dev) — the cron still covers it
  const repo = process.env.GH_REPO ?? 'VictorP2027/nawilis-spk';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'flow-action', client_payload: { jobId, spkId, action } }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`triggerFlowRun: GitHub dispatch failed ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (e) {
    console.error(`triggerFlowRun: ${(e as Error).message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request): Promise<Response> {
  await db();
  const json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) {
    return NextResponse.json({ error: 'invalid_json', message: 'Body JSON tidak valid' }, { status: 400 });
  }

  // Board "Coba Lagi" on a failed job: put it straight back in the queue.
  if (typeof json.retryJobId === 'string' && json.retryJobId) {
    const ok = await retryFlowJob(json.retryJobId);
    if (!ok) {
      return NextResponse.json({ error: 'job_not_failed', message: 'Job tidak ditemukan atau tidak dalam status gagal' }, { status: 404 });
    }
    await triggerFlowRun(json.retryJobId, '', 'retry');
    return NextResponse.json({ jobId: json.retryJobId, state: 'queued', retried: true }, { status: 202 });
  }

  const action = normalizeAction(json.action);
  if (!action) {
    return NextResponse.json(
      { error: 'invalid_action', message: 'Aksi tidak dikenal', validActions: FLOW_ACTIONS },
      { status: 400 },
    );
  }

  const params = (json.params && typeof json.params === 'object' && !Array.isArray(json.params)
    ? json.params
    : {}) as Record<string, unknown>;
  const by = typeof json.by === 'string' && json.by ? json.by : 'flow-board';
  const spkId = typeof json.spkId === 'string' ? json.spkId : '';
  const isDocless = DOCLESS_ACTIONS.includes(action);

  if (!spkId && !isDocless) {
    return NextResponse.json({ error: 'missing_spkId', message: 'spkId wajib untuk aksi ini' }, { status: 400 });
  }

  if (spkId) {
    const doc = await collections.spk().findOne({ _id: spkId });
    if (!doc) {
      return NextResponse.json({ error: 'not_found', message: `Dokumen ${spkId} tidak ditemukan` }, { status: 404 });
    }

    // Stage guard: the board derives its ONE primary button from the same flow
    // helpers, so an illegal action here is a stale card — refuse loudly rather
    // than queue an RPA step that must fail. {force:true} bypasses (ops rescue).
    const f = effectiveFlow(doc);
    if (json.force !== true && !canRunFlowAction(f, action)) {
      return NextResponse.json(
        {
          error: 'invalid_stage',
          message: `Aksi "${FLOW_ACTION_LABELS[action]}" tidak valid untuk tahap dokumen saat ini — muat ulang board`,
          flow: f,
        },
        { status: 409 },
      );
    }

    // Double-click / double-tab guard: an identical job already in flight is
    // returned as-is instead of queueing the same Turboly step twice.
    const existing = await flowJobs().findOne({ spkId, action, state: { $in: ['queued', 'running'] } });
    if (existing) {
      return NextResponse.json({ jobId: existing._id, spkId, action, state: existing.state, deduped: true }, { status: 200 });
    }

    await ensureFlowInitialized(spkId);
  }

  try {
    const job = await enqueueFlowJob(spkId, action, params, by);
    await triggerFlowRun(job._id, spkId, action);
    return NextResponse.json({ jobId: job._id, spkId: spkId || null, action, state: job.state }, { status: 202 });
  } catch (e) {
    console.error('flow action enqueue error', e);
    return NextResponse.json({ error: 'enqueue_failed', message: (e as Error).message }, { status: 500 });
  }
}
