import type { Collection, UpdateFilter } from 'mongodb';
import { ulid } from 'ulid';
import { getDb } from './mongo.js';

/**
 * FLOW v2 — full Turboly lifecycle state for one SPK / Check&Go document, plus
 * the `flow_jobs` queue the board actions run through.
 *
 * The push pipeline (rpaSink) still owns SPK → Service Order creation. From
 * there the FLOW takes over: Approve SO → Create WO → Start → Complete →
 * QC → Invoice → Complete Invoice. Every step is a queued FlowJob executed
 * serially by the flow worker against the ONE Turboly session.
 *
 * MongoDB is the system of record: `spk.flow` mirrors what Turboly showed us
 * after each verified step; the job row carries in-flight/error state for the
 * board UI.
 */

// ─────────────────────────────────────────────────────────────────────────
// Stage state machine
// ─────────────────────────────────────────────────────────────────────────

/** Turboly Service Order workflow, as far as the flow cares. */
export type FlowSoStage = 'created' | 'approved';
/** Turboly Service Work Order workflow (WAITING → IN PROGRESS → WAITING FOR QC → COMPLETED). */
export type FlowWoStage = 'created' | 'in_progress' | 'waiting_qc' | 'completed';
/** Turboly Service Invoice workflow (DRAFT → COMPLETED). */
export type FlowInvoiceStage = 'draft' | 'completed';

export type FlowPaymentMethod = 'Cash' | 'Transfer' | 'QRIS' | 'EDC';
export const FLOW_PAYMENT_METHODS: readonly FlowPaymentMethod[] = ['Cash', 'Transfer', 'QRIS', 'EDC'];

/**
 * Lifecycle position of one document. Lives at `SpkDoc.flow` (optional,
 * additive). `so: null` = the SO hasn't been created yet (intake / still in
 * the push pipeline). Doc numbers/urls for SO live in `doc.turboly`; WO and
 * invoice refs discovered by the flow live here.
 */
export interface FlowState {
  so: FlowSoStage | null;
  wo: FlowWoStage | null;
  invoice: FlowInvoiceStage | null;

  workOrderNo: string | null;
  workOrderUrl: string | null;
  invoiceNo: string | null;
  invoiceUrl: string | null;

  /** Check & Go: customer declined follow-up repairs — record stays check-only. */
  checkOnly: boolean;

  /** Captured at [Selesai]: actual duration + mechanic findings (keluhan template source). */
  waktuMinutes: number | null;
  findings: string | null;

  /** Captured at [QC OK]: next-service recommendations written onto the WO. */
  nextOdometer: number | null;
  nextServiceDate: string | null; // ISO date (YYYY-MM-DD)
  recommendations: string | null;

  /** Captured at [Buat Invoice]; used by [Selesaikan Invoice]. */
  payment: { method: FlowPaymentMethod; amount: number } | null;

  updatedAt: string; // ISO
}

/** Fresh flow state for a new intake doc (nothing exists in Turboly yet). */
export function initFlow(): FlowState {
  return {
    so: null,
    wo: null,
    invoice: null,
    workOrderNo: null,
    workOrderUrl: null,
    invoiceNo: null,
    invoiceUrl: null,
    checkOnly: false,
    waktuMinutes: null,
    findings: null,
    nextOdometer: null,
    nextServiceDate: null,
    recommendations: null,
    payment: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Board-ready view of a doc's flow: docs pushed BEFORE flow v2 (or whose flow
 * write lagged) still land in the right column by deriving `so`/`wo` from the
 * read-back doc numbers in `doc.turboly`.
 */
export function effectiveFlow(doc: {
  flow?: FlowState | null;
  turboly?: { serviceOrderNo?: string | null; workOrderNo?: string | null } | null;
}): FlowState {
  const f: FlowState = { ...initFlow(), ...(doc.flow ?? {}) };
  // The pusher already clicks Approve right after saving (PUSH_APPROVE=true, and
  // verified live: pushed SOs sit on the "Approved" workflow step). So a pushed
  // Service Order is APPROVED — the board must not ask staff to approve again.
  if (f.so == null && doc.turboly?.serviceOrderNo) f.so = 'approved';
  if (f.wo == null && doc.turboly?.workOrderNo) {
    f.wo = 'created';
    f.workOrderNo = f.workOrderNo ?? doc.turboly.workOrderNo ?? null;
  }
  return f;
}

// ─────────────────────────────────────────────────────────────────────────
// Board columns
// ─────────────────────────────────────────────────────────────────────────

/** Flow-board columns: Intake → SO → WO → QC → Invoice → Selesai. */
export type FlowBoardColumn = 'intake' | 'so' | 'wo' | 'qc' | 'invoice' | 'done';

export const FLOW_BOARD_COLUMNS: readonly FlowBoardColumn[] = ['intake', 'so', 'wo', 'qc', 'invoice', 'done'];

/** Staff-facing column titles (Indonesian). */
export const FLOW_BOARD_LABELS: Record<FlowBoardColumn, string> = {
  intake: 'Intake',
  so: 'Service Order',
  wo: 'Work Order',
  qc: 'QC',
  invoice: 'Invoice',
  done: 'Selesai',
};

/** Which column a doc's card sits in. */
export function boardColumn(flow: FlowState | null | undefined): FlowBoardColumn {
  const f = flow ?? initFlow();
  if (f.invoice === 'completed') return 'done';
  if (f.invoice === 'draft') return 'invoice';
  if (f.wo === 'completed') return 'invoice'; // QC passed — waiting for [Buat Invoice]
  if (f.wo === 'waiting_qc') return 'qc';
  if (f.wo === 'created' || f.wo === 'in_progress') return 'wo';
  if (f.so != null) return 'so';
  return 'intake';
}

/** Short Indonesian sub-stage label for the card (e.g. badge under the doc number). */
export function stageLabel(flow: FlowState | null | undefined): string {
  const f = flow ?? initFlow();
  if (f.invoice === 'completed') return 'Selesai';
  if (f.invoice === 'draft') return 'Invoice draft';
  if (f.wo === 'completed') return 'QC OK — siap invoice';
  if (f.wo === 'waiting_qc') return 'Menunggu QC';
  if (f.wo === 'in_progress') return 'Sedang dikerjakan';
  if (f.wo === 'created') return 'WO menunggu start';
  if (f.so === 'approved') return 'SO approved (otomatis)';
  if (f.so === 'created') return 'SO dibuat — belum approve';
  return 'Belum masuk Turboly';
}

// ─────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────

export const FLOW_ACTIONS = [
  'approve_so',
  'create_wo',
  'start_wo',
  'complete_wo',
  'qc_ok',
  'create_invoice',
  'complete_invoice',
  'fill_inspections',
  'stay_check_only',
  'register_customer_retail',
  'register_customer_wholesale',
] as const;

export type FlowActionType = (typeof FLOW_ACTIONS)[number];

export function isFlowAction(v: unknown): v is FlowActionType {
  return typeof v === 'string' && (FLOW_ACTIONS as readonly string[]).includes(v);
}

/** Staff-facing button labels (Indonesian, per the board spec). */
export const FLOW_ACTION_LABELS: Record<FlowActionType, string> = {
  approve_so: 'Approve SO',
  create_wo: 'Buat Work Order',
  start_wo: 'Start',
  complete_wo: 'Selesai',
  qc_ok: 'QC OK',
  create_invoice: 'Buat Invoice',
  complete_invoice: 'Selesaikan Invoice',
  fill_inspections: 'Isi Inspeksi',
  stay_check_only: 'Tetap Check Saja',
  register_customer_retail: 'Daftarkan Customer Retail',
  register_customer_wholesale: 'Daftarkan Customer Corporate',
};

/** Typed params for the doc-bound actions (job.params is stored untyped). */
export interface CreateWoParams { assigneeName: string }
export interface CompleteWoParams { waktuMinutes: number; findings: string }
export interface QcOkParams { nextOdometer?: number | null; nextServiceDate?: string | null; recommendations?: string | null }
export interface CreateInvoiceParams { method: FlowPaymentMethod; amount: number }
export interface CompleteInvoiceParams { method?: FlowPaymentMethod; amount?: number }

/**
 * The ONE primary next step for a card, or null (nothing to do / waiting on
 * the push pipeline / done).
 */
export function nextFlowAction(flow: FlowState | null | undefined): FlowActionType | null {
  const f = flow ?? initFlow();
  if (f.invoice === 'completed') return null;
  if (f.invoice === 'draft') return 'complete_invoice';
  if (f.wo === 'completed') return 'create_invoice';
  if (f.wo === 'waiting_qc') return 'qc_ok';
  if (f.wo === 'in_progress') return 'complete_wo';
  if (f.wo === 'created') return 'start_wo';
  if (f.so === 'approved') return 'create_wo';
  if (f.so === 'created') return 'approve_so';
  return null; // intake — the push pipeline creates the SO first
}

/** Precondition check — is this action legal from this flow state? */
export function canRunFlowAction(flow: FlowState | null | undefined, action: FlowActionType): boolean {
  const f = flow ?? initFlow();
  switch (action) {
    case 'approve_so': return f.so === 'created';
    case 'create_wo': return f.so === 'approved' && f.wo == null;
    case 'start_wo': return f.wo === 'created';
    case 'complete_wo': return f.wo === 'in_progress';
    case 'qc_ok': return f.wo === 'waiting_qc';
    case 'create_invoice': return f.wo === 'completed' && f.invoice == null;
    case 'complete_invoice': return f.invoice === 'draft';
    case 'fill_inspections': return f.so != null;
    case 'stay_check_only': return true;
    case 'register_customer_retail': return true;
    case 'register_customer_wholesale': return true;
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * The `flow` patch to $set after an action SUCCEEDS. `params` is the job's
 * request payload; `result` is what the RPA returned (doc numbers/urls).
 * Registration actions don't touch a doc's flow — they return {}.
 */
export function flowPatchAfter(
  action: FlowActionType,
  params: Record<string, unknown> = {},
  result: Record<string, unknown> = {},
): Partial<FlowState> {
  switch (action) {
    case 'approve_so':
      return { so: 'approved' };
    case 'create_wo':
      return { wo: 'created', workOrderNo: str(result.workOrderNo), workOrderUrl: str(result.workOrderUrl) };
    case 'start_wo':
      return { wo: 'in_progress' };
    case 'complete_wo':
      return { wo: 'waiting_qc', waktuMinutes: num(params.waktuMinutes), findings: str(params.findings) };
    case 'qc_ok':
      return {
        wo: 'completed',
        nextOdometer: num(params.nextOdometer),
        nextServiceDate: str(params.nextServiceDate),
        recommendations: str(params.recommendations),
      };
    case 'create_invoice': {
      const method = str(params.method);
      const amount = num(params.amount);
      return {
        invoice: 'draft',
        invoiceNo: str(result.invoiceNo),
        invoiceUrl: str(result.invoiceUrl),
        payment:
          method && amount != null && (FLOW_PAYMENT_METHODS as readonly string[]).includes(method)
            ? { method: method as FlowPaymentMethod, amount }
            : null,
      };
    }
    case 'complete_invoice':
      return { invoice: 'completed' };
    case 'stay_check_only':
      return { checkOnly: true };
    case 'fill_inspections':
    case 'register_customer_retail':
    case 'register_customer_wholesale':
      return {};
  }
}

/**
 * Keluhan template for the WO when the mechanic found something (Check & Go):
 * "From inspection, there was problem with … so we did …".
 */
export function keluhanFromFindings(problem: string, actionTaken: string): string {
  return `From inspection, there was problem with ${problem.trim()} so we did ${actionTaken.trim()}`;
}

// ─────────────────────────────────────────────────────────────────────────
// SpkDoc.flow.* update helpers
// ─────────────────────────────────────────────────────────────────────────

/** Minimal local view of the spk collection — only what the flow touches. */
interface SpkFlowHost {
  _id: string;
  flow?: FlowState;
  updatedAt?: string;
}

const spkFlowCol = (): Collection<SpkFlowHost> => getDb().collection<SpkFlowHost>('spk');

/**
 * Apply a partial flow patch with dotted $set paths, so concurrent writers
 * (push worker vs flow worker) never clobber each other's flow fields.
 * Returns true when the doc existed.
 */
export async function updateFlow(spkId: string, patch: Partial<FlowState>): Promise<boolean> {
  const now = new Date().toISOString();
  const sets: Record<string, unknown> = { 'flow.updatedAt': now, updatedAt: now };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== 'updatedAt') sets[`flow.${k}`] = v;
  }
  const res = await spkFlowCol().updateOne({ _id: spkId }, { $set: sets } as unknown as UpdateFilter<SpkFlowHost>);
  return res.matchedCount > 0;
}

/** Initialise `flow` on a doc that doesn't have one yet (no-op when present). */
export async function ensureFlowInitialized(spkId: string): Promise<void> {
  await spkFlowCol().updateOne(
    { _id: spkId, flow: { $exists: false } },
    { $set: { flow: initFlow() } } as unknown as UpdateFilter<SpkFlowHost>,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// flow_jobs queue
// ─────────────────────────────────────────────────────────────────────────

export type FlowJobState = 'queued' | 'running' | 'done' | 'failed';

/** Staff-facing job-state labels for the board (Indonesian). */
export const FLOW_JOB_STATE_LABELS: Record<FlowJobState, string> = {
  queued: 'Antre',
  running: 'Diproses…',
  done: 'Berhasil',
  failed: 'Gagal',
};

/**
 * One queued board action. `_id` is a ulid. `spkId` is '' for jobs not bound
 * to a doc (customer registration). Beyond the required core, the extra
 * bookkeeping fields are optional so a minimal insert (per spec) stays valid.
 */
export interface FlowJob {
  _id: string; // ulid
  spkId: string;
  action: FlowActionType;
  params: Record<string, unknown>;
  state: FlowJobState;
  attempts: number;
  createdAt: string; // ISO
  updatedAt?: string;
  maxAttempts?: number;
  /** Transient failures re-queue with a due time; null/absent = due now. */
  nextAttemptAt?: string | null;
  error?: string | null;
  /** RPA result payload (doc numbers, customer url) for the board UI. */
  result?: Record<string, unknown> | null;
  by?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export const FLOW_JOB_MAX_ATTEMPTS = 5;

/** flow_jobs collection accessor (local by design — mongo.ts is not edited). */
export const flowJobs = (): Collection<FlowJob> => getDb().collection<FlowJob>('flow_jobs');

/** Build (without inserting) a fresh queued job doc. */
export function buildFlowJob(
  spkId: string,
  action: FlowActionType,
  params: Record<string, unknown> = {},
  by: string | null = null,
): FlowJob {
  const now = new Date().toISOString();
  return {
    _id: ulid(),
    spkId,
    action,
    params,
    state: 'queued',
    attempts: 0,
    maxAttempts: FLOW_JOB_MAX_ATTEMPTS,
    nextAttemptAt: null,
    error: null,
    result: null,
    by,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

/** Insert a queued job and return it. */
export async function enqueueFlowJob(
  spkId: string,
  action: FlowActionType,
  params: Record<string, unknown> = {},
  by: string | null = null,
): Promise<FlowJob> {
  const job = buildFlowJob(spkId, action, params, by);
  await flowJobs().insertOne(job);
  return job;
}

/**
 * CAS-claim the oldest due queued job (queued → running). Two workers can
 * never both run the same job: the state is pinned in the filter.
 */
export async function claimNextFlowJob(): Promise<FlowJob | null> {
  const now = new Date().toISOString();
  const res = await flowJobs().findOneAndUpdate(
    {
      state: 'queued',
      $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
    },
    { $set: { state: 'running', startedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  return res ?? null;
}

/** Mark a running job done (with the RPA's result payload for the board). */
export async function completeFlowJob(jobId: string, result: Record<string, unknown> | null = null): Promise<void> {
  const now = new Date().toISOString();
  await flowJobs().updateOne(
    { _id: jobId, state: 'running' },
    { $set: { state: 'done', result, error: null, finishedAt: now, updatedAt: now } },
  );
}

/**
 * Mark a running job failed. `transient: true` re-queues it (with a delay)
 * until maxAttempts is spent — mirroring the push worker's retry philosophy.
 */
export async function failFlowJob(
  jobId: string,
  error: string,
  opts: { transient?: boolean; retryInMs?: number } = {},
): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const job = await flowJobs().findOne({ _id: jobId });
  const attempts = job?.attempts ?? FLOW_JOB_MAX_ATTEMPTS;
  const maxAttempts = job?.maxAttempts ?? FLOW_JOB_MAX_ATTEMPTS;
  const requeue = (opts.transient ?? false) && attempts < maxAttempts;
  await flowJobs().updateOne(
    { _id: jobId, state: 'running' },
    {
      $set: requeue
        ? {
            state: 'queued' as const,
            error,
            nextAttemptAt: new Date(now + (opts.retryInMs ?? 60_000)).toISOString(),
            updatedAt: nowIso,
          }
        : { state: 'failed' as const, error, finishedAt: nowIso, updatedAt: nowIso },
    },
  );
}

/** Board "Coba Lagi": put a failed job back in the queue immediately. */
export async function retryFlowJob(jobId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const res = await flowJobs().updateOne(
    { _id: jobId, state: 'failed' },
    { $set: { state: 'queued', nextAttemptAt: null, updatedAt: now }, $unset: { finishedAt: '' } },
  );
  return res.modifiedCount > 0;
}

/** Open (queued/running/failed) jobs, oldest first — the board's in-flight strip. */
export async function openFlowJobs(spkIds?: string[]): Promise<FlowJob[]> {
  const filter: Record<string, unknown> = { state: { $in: ['queued', 'running', 'failed'] } };
  if (spkIds && spkIds.length) filter.spkId = { $in: spkIds };
  return flowJobs().find(filter).sort({ createdAt: 1 }).limit(500).toArray();
}

/** Indexes the queue scan + board queries need. Idempotent. */
export async function ensureFlowIndexes(): Promise<void> {
  await flowJobs().createIndexes([
    { key: { state: 1, nextAttemptAt: 1, createdAt: 1 }, name: 'ix_flow_queue' },
    { key: { spkId: 1, createdAt: -1 }, name: 'ix_flow_spk' },
  ]);
}
