import {
  connect, close, collections, emit, getDb,
  flowJobs, claimNextFlowJob, completeFlowJob, failFlowJob, ensureFlowIndexes,
  updateFlow, flowPatchAfter, effectiveFlow, isFlowAction, keluhanFromFindings,
  FLOW_JOB_MAX_ATTEMPTS, FLOW_PAYMENT_METHODS,
  type FlowActionType, type FlowJob, type FlowPaymentMethod, type FlowState, type SpkDoc,
} from '@spk/core';
import {
  TurbolySession, TurbolyFlowRpa,
  AuthChallengeError, DataError, TransientError, LeaseLostError,
} from '@spk/core/turboly';
import { config } from './config.js';

/**
 * Redis-free ONE-SHOT flow-job drain — the executor behind the flow board.
 * Claims every `queued` flow_jobs row (CAS queued→running), runs the Turboly
 * lifecycle step through TurbolyFlowRpa on the process's ONE live session,
 * then updates spk.flow.* + the job row (done / failed / requeued-transient).
 * Exits when the queue is empty. Runs from flow.yml, which shares the
 * `turboly-push` concurrency group so it is NEVER parallel with the pusher.
 *
 *   node --import tsx apps/worker/src/flow-once.ts             # drain all queued
 *   node --import tsx apps/worker/src/flow-once.ts --id=01K...  # run one job
 */

const TIME_BUDGET_MS = 50 * 60_000; // stay under the workflow's 60-min timeout

/**
 * How long an idle-but-warm runner waits for the next board action before it
 * exits.
 *
 * The board enqueues ONE job per click (Approve SO, then Buat WO, then Start…),
 * and each click fires its own repository_dispatch. Without this, every click
 * pays a fresh runner: 60-90s of checkout + npm ci + Playwright install before
 * the process exists, then another Turboly login — for a step that takes a few
 * seconds. Staying alive across a burst of clicks reuses both. Registration is
 * the same story: the owner registering two customers in a row used to queue
 * the second behind the first run AND a second cold start.
 *
 * Bounded and only after real work, because push.yml/sync.yml share the
 * `turboly-push` concurrency group — every idle second here is a second the
 * pusher waits. Holding the session idle is safe: a kick while we do nothing
 * costs nothing, the next job's ensureLoggedIn logs back in.
 */
const GRACE_MS = Number.isFinite(Number(process.env.FLOW_DRAIN_GRACE_MS)) ? Number(process.env.FLOW_DRAIN_GRACE_MS) : 20_000;
const GRACE_POLL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── small param helpers (board clients vary in key spelling) ───────────────

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

/** SpkDoc + the flow-v2 additive fields this worker reads/writes. */
type FlowDoc = SpkDoc & {
  flow?: FlowState | null;
  checkGo?: { harga?: number | null; inspectionItems?: unknown[] | null } | null;
};

// ── the process's ONE Turboly session (re-made when the branch changes) ────

/**
 * Turboly allows ONE SESSION PER USER, and every branch logs in with the SAME
 * .env credentials — so keeping a rig alive per branch kicked our own earlier
 * rigs the moment a job for a second branch arrived, and the kicked rig then
 * met a sign-in page mid-action (live: create_wo "dialihkan ke /dashboard 3×").
 * Hence one live rig: a different branchCode disposes it BEFORE the new login.
 * The drain loop is serial, so nothing is ever mid-action during the swap.
 * A swap costs a fresh login, so same-branch jobs in a row reuse the rig.
 */
class BranchFlowRigs {
  private rig: { branchCode: string; session: TurbolySession; rpa: TurbolyFlowRpa } | null = null;

  async rpaFor(branchCode: string): Promise<TurbolyFlowRpa> {
    if (this.rig && this.rig.branchCode !== branchCode) {
      const stale = this.rig;
      this.rig = null;
      await stale.session.dispose().catch(() => {});
    }
    if (!this.rig) {
      const session = new TurbolySession({
        baseUrl: config.turbolyBaseUrl,
        stateDir: config.turbolyStateDir,
        userAgentSuffix: config.userAgentSuffix,
        branchCode,
      });
      await session.start();
      this.rig = { branchCode, session, rpa: new TurbolyFlowRpa(session, { screenshotDir: config.screenshotDir }) };
    }
    await this.rig.session.ensureLoggedIn();
    return this.rig.rpa;
  }

  /**
   * A kick is still routine even with one rig — a human login (or the web app's
   * HTTP lookup) takes the account from us mid-action. It surfaces as a
   * Discovery/Data error (a sign-in modal blankets the page, buttons
   * "disappear"), which classify() would mark PERMANENT. So after any failure,
   * probe the live page for the sign-in text (same probe as
   * rpaSink.classifyFailure) — kicked means transient: the retry's
   * ensureLoggedIn() logs back in.
   */
  async anySessionKicked(): Promise<boolean> {
    const rig = this.rig;
    if (!rig) return false;
    try {
      return await rig.session
        .page_()
        .evaluate(() => /you need to sign in|you have been logged out|sign in or sign up/i.test(document.body?.innerText ?? ''));
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    const rig = this.rig;
    this.rig = null;
    await rig?.session.dispose().catch(() => {});
  }
}

// ── failure classification (same philosophy as the push worker) ────────────

function classify(e: unknown): { transient: boolean; msg: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : '';
  if (e instanceof AuthChallengeError || name === 'AuthChallengeError') {
    return { transient: false, msg: `Login Turboly gagal — jalankan npm run login:turboly. (${msg})` };
  }
  if (e instanceof DataError || name === 'DataError') return { transient: false, msg };
  if (e instanceof TransientError || e instanceof LeaseLostError || name === 'TransientError' || name === 'LeaseLostError') {
    return { transient: true, msg };
  }
  // Session kicked / network flake / dead page → retry later logs in fresh.
  // "Execution context was destroyed" means an evaluate raced a navigation the
  // page was already doing — nothing was decided, so the step simply reruns.
  // Filed as permanent it stops the lifecycle dead and pages a human for a race.
  if (/timeout|timed out|net::|ERR_|kicked|target closed|browser has been closed|navigation failed|execution context was destroyed|frame was detached/i.test(msg)) {
    return { transient: true, msg };
  }
  // Structural (selector/control not found — DiscoveryError et al): a human/dev fix.
  return { transient: false, msg };
}

// ── inspection items: board params or the doc's stored Check&Go checklist ──

interface RawInspectionItem { item?: unknown; catatan?: unknown; feedback?: unknown; recommendation?: unknown; description?: unknown; category?: unknown }

function inspectionItemsFor(doc: FlowDoc | null, p: Record<string, unknown>): Array<{ category: string; description: string; feedback?: string | null; recommendation?: string | null }> {
  const raw: RawInspectionItem[] = Array.isArray(p.items)
    ? (p.items as RawInspectionItem[])
    : ((doc?.checkGo?.inspectionItems ?? []) as RawInspectionItem[]);
  const items = raw.map((r) => {
    const desc = [str(r.item) ?? str(r.description), str(r.catatan)].filter(Boolean).join(' — ') || 'Check and Go';
    return {
      category: str(r.category) ?? 'Check and Go',
      description: desc,
      feedback: str(r.feedback),
      recommendation: str(r.recommendation),
    };
  });
  // Default = the single "Check and Go" category row.
  return items.length ? items : [{ category: 'Check and Go', description: 'Check and Go', feedback: null, recommendation: null }];
}

// ── the per-action executor ────────────────────────────────────────────────

/**
 * Run one job's Turboly step. Returns the result payload stored on the job
 * (doc numbers/urls, normalized inputs). `alreadyDone: true` = the flow state
 * says this step already happened — skip the RPA AND the flow patch (never
 * downgrade a further-along state on a duplicate/retried job).
 */
async function executeJob(
  job: FlowJob,
  action: FlowActionType,
  p: Record<string, unknown>,
  rigs: BranchFlowRigs,
): Promise<Record<string, unknown>> {
  const doc = job.spkId ? ((await collections.spk().findOne({ _id: job.spkId })) as FlowDoc | null) : null;
  if (job.spkId && !doc) throw new DataError(`Dokumen ${job.spkId} tidak ditemukan di Mongo`);

  // Mongo-only action — no Turboly involved.
  if (action === 'stay_check_only') {
    if (!doc) throw new DataError('Aksi "Tetap Check Saja" membutuhkan spkId');
    const ts = new Date().toISOString();
    await collections.spk().updateOne({ _id: doc._id }, { $set: { 'checkGo.stayCheckOnly': true, 'checkGo.stayCheckOnlyAt': ts } });
    return { checkOnly: true };
  }

  const f = doc ? effectiveFlow(doc) : null;
  const branchCode = doc?.branchCode ?? str(p.branchCode) ?? str(p.storeCode) ?? '';
  if (!branchCode) throw new DataError('branchCode tidak ada — sertakan params.branchCode untuk registrasi customer');

  const soUrl = str(doc?.turboly?.serviceOrderUrl) ?? str(p.serviceOrderUrl);
  const woUrl = str(f?.workOrderUrl) ?? str(p.workOrderUrl);
  const invUrl = str(f?.invoiceUrl) ?? str(p.invoiceUrl);
  const needSo = (): string => {
    if (!soUrl) throw new DataError('URL Service Order belum ada — tunggu push SO selesai dulu');
    return soUrl;
  };
  const needWo = (): string => {
    if (!woUrl) throw new DataError('URL Work Order belum ada — jalankan "Buat Work Order" dulu');
    return woUrl;
  };

  switch (action) {
    case 'approve_so': {
      if (f?.so === 'approved') return { alreadyDone: true };
      const url = needSo();
      const rpa = await rigs.rpaFor(branchCode);
      await rpa.approveServiceOrder(url);
      return {};
    }

    case 'create_wo': {
      // Idempotency: ANY recorded wo state means the WO exists — including the
      // state derived by effectiveFlow from a mirrored turboly.workOrderNo,
      // where workOrderUrl is null. NEVER click create twice; when the URL is
      // missing, recover it from the SO page instead.
      if (f?.wo != null) {
        if (f.workOrderUrl) {
          return { alreadyDone: true, workOrderNo: f.workOrderNo, workOrderUrl: f.workOrderUrl };
        }
        const soPage = needSo();
        const rpa = await rigs.rpaFor(branchCode);
        const linked = await rpa.findLinkedWorkOrder(soPage);
        if (!linked) {
          throw new DataError(
            `WO ${f.workOrderNo ?? ''} sudah tercatat tapi URL-nya tidak ditemukan di halaman SO — cek Turboly atau isi params.workOrderUrl`.replace(/\s+/g, ' '),
          );
        }
        if (job.spkId) {
          await updateFlow(job.spkId, { workOrderNo: linked.workOrderNo ?? f.workOrderNo, workOrderUrl: linked.workOrderUrl });
        }
        return { alreadyDone: true, workOrderNo: linked.workOrderNo ?? f.workOrderNo, workOrderUrl: linked.workOrderUrl };
      }
      const url = needSo();
      const assignee = str(p.assigneeName) ?? str(p.mechanicName) ?? str(p.mechanic) ?? str(p.assignee) ?? str(p.name);
      if (!assignee) throw new DataError('Nama mekanik (params.assigneeName) wajib untuk Buat Work Order');
      const rpa = await rigs.rpaFor(branchCode);
      // The mechanic list is per store, and a mechanic from another branch is
      // rejected outright, so the sink needs this branch's Turboly store id.
      const storeDoc = await getDb().collection('tb_stores').findOne({ _id: branchCode } as never);
      const storeId = (storeDoc as { turbolyStoreId?: string } | null)?.turbolyStoreId ?? null;
      const r = await rpa.createWorkOrder(url, assignee, storeId);
      return { ...r, assigneeName: assignee };
    }

    case 'start_wo': {
      if (f?.wo === 'in_progress' || f?.wo === 'waiting_qc' || f?.wo === 'completed') return { alreadyDone: true };
      const url = needWo();
      const rpa = await rigs.rpaFor(branchCode);
      await rpa.startWorkOrder(url);
      return {};
    }

    case 'complete_wo': {
      if (f?.wo === 'waiting_qc' || f?.wo === 'completed') return { alreadyDone: true };
      const url = needWo();
      const waktuMinutes = num(p.waktuMinutes) ?? num(p.waktu) ?? num(p.minutes) ?? doc?.estimasi?.minutes ?? 30;
      // Keluhan template: "From inspection, there was problem with … so we did …"
      const problem = str(p.problem) ?? str(p.temuan) ?? str(p.masalah);
      const actionTaken = str(p.actionTaken) ?? str(p.tindakan);
      const feedback =
        str(p.feedback) ?? str(p.findings) ?? str(p.catatan) ??
        (problem && actionTaken
          ? keluhanFromFindings(problem, actionTaken)
          : problem
            ? `From inspection, there was problem with ${problem}`
            : 'General check selesai — tidak ditemukan masalah');
      const rpa = await rigs.rpaFor(branchCode);
      await rpa.completeWorkOrder(url, { waktuMinutes, feedback });
      return { waktuMinutes, feedback, findings: str(p.findings) ?? feedback };
    }

    case 'qc_ok': {
      if (f?.wo === 'completed') return { alreadyDone: true };
      const url = needWo();
      const nextOdometer = num(p.nextOdometer) ?? num(p.nextKm);
      const nextServiceDateISO = str(p.nextServiceDateISO) ?? str(p.nextServiceDate);
      const recommendations = str(p.recommendations) ?? str(p.rekomendasi);
      const rpa = await rigs.rpaFor(branchCode);
      await rpa.qcApprove(url, { nextOdometer, nextServiceDateISO, recommendations });
      return { nextOdometer, nextServiceDate: nextServiceDateISO, recommendations };
    }

    case 'create_invoice': {
      // Idempotency: mirror of create_wo — never click create twice; recover a
      // lost invoice URL from the WO page.
      if (f?.invoice != null) {
        if (f.invoiceUrl) return { alreadyDone: true, invoiceNo: f.invoiceNo, invoiceUrl: f.invoiceUrl };
        const woPage = needWo();
        const rpa = await rigs.rpaFor(branchCode);
        const linked = await rpa.findLinkedInvoice(woPage);
        if (!linked) {
          throw new DataError(
            `Invoice ${f.invoiceNo ?? ''} sudah tercatat tapi URL-nya tidak ditemukan di halaman WO — cek Turboly atau isi params.invoiceUrl`.replace(/\s+/g, ' '),
          );
        }
        if (job.spkId) {
          await updateFlow(job.spkId, { invoiceNo: linked.invoiceNo ?? f.invoiceNo, invoiceUrl: linked.invoiceUrl });
        }
        return { alreadyDone: true, invoiceNo: linked.invoiceNo ?? f.invoiceNo, invoiceUrl: linked.invoiceUrl };
      }
      const url = needWo();
      const rpa = await rigs.rpaFor(branchCode);
      const r = await rpa.createInvoice(url);
      return { ...r };
    }

    case 'complete_invoice': {
      if (f?.invoice === 'completed') return { alreadyDone: true };
      if (!invUrl) throw new DataError('URL Invoice belum ada — jalankan "Buat Invoice" dulu');
      const method = str(p.method) ?? str(p.paymentMethod) ?? f?.payment?.method ?? 'Cash';
      const amount = num(p.amount) ?? f?.payment?.amount ?? num(doc?.jobLineSummary?.quotedTotal) ?? 0;
      const rpa = await rigs.rpaFor(branchCode);
      await rpa.completeInvoice(invUrl, { method, amount });
      return { method, amount };
    }

    case 'fill_inspections': {
      const url = needSo();
      const items = inspectionItemsFor(doc, p);
      const rpa = await rigs.rpaFor(branchCode);
      await rpa.fillInspections(url, items);
      if (doc) {
        await collections.spk().updateOne({ _id: doc._id }, { $set: { 'checkGo.inspectionsPushedAt': new Date().toISOString() } });
      }
      return { count: items.length };
    }

    case 'register_customer_retail': {
      const nama = str(p.nama) ?? str(p.name);
      if (!nama) throw new DataError('Nama customer (params.nama) wajib');
      // The store lookup and the browser launch + login are independent, and the
      // browser is by far the slower of the two — pay them together instead of
      // adding an Atlas round trip in front of it.
      const storeIdParam = str(p.storeTurbolyId);
      const [storeTurbolyId, rpa] = await Promise.all([
        storeIdParam
          ? Promise.resolve<string | null>(storeIdParam)
          : collections.tbStores().findOne({ _id: branchCode }).then((s) => s?.turbolyStoreId ?? null),
        rigs.rpaFor(branchCode),
      ]);
      const r = await rpa.registerRetailCustomer({
        nama,
        phone: str(p.phone) ?? str(p.wa) ?? '',
        alamat: str(p.alamat) ?? str(p.address) ?? '',
        storeTurbolyId,
        companyName: str(p.companyName),
      });
      return { ...r };
    }

    case 'register_customer_wholesale': {
      const companyName = str(p.companyName) ?? str(p.company);
      if (!companyName) throw new DataError('Nama perusahaan (params.companyName) wajib');
      // Linked retail customer (created right after the company) — from
      // params.retail {...} or flat nama/phone params when provided.
      const rp = (p.retail && typeof p.retail === 'object' ? p.retail : {}) as Record<string, unknown>;
      const retailNama = str(rp.nama) ?? str(rp.name) ?? str(p.nama) ?? str(p.name);
      // Same overlap as the retail case: the store lookup rides alongside the
      // browser launch + login rather than delaying it.
      const storeIdParam = str(rp.storeTurbolyId) ?? str(p.storeTurbolyId);
      const [storeTurbolyId, rpa] = await Promise.all([
        !retailNama || storeIdParam
          ? Promise.resolve<string | null>(storeIdParam)
          : collections.tbStores().findOne({ _id: branchCode }).then((s) => s?.turbolyStoreId ?? null),
        rigs.rpaFor(branchCode),
      ]);

      // Two-step with a job-row CHECKPOINT: the company save is irreversible,
      // so when the retail half fails (e.g. the fresh company is not yet
      // searchable in select2) the retry must NOT create the company again.
      // The checkpoint survives both transient requeues and the board's retry.
      type WholesaleProgress = { companyId?: string | null; companyUrl?: string | null };
      const prog = (job as FlowJob & { progress?: WholesaleProgress | null }).progress ?? null;
      let companyId: string | null;
      let companyUrl: string;
      let note: string | null = null;
      if (prog?.companyUrl) {
        companyId = prog.companyId ?? null;
        companyUrl = prog.companyUrl;
        note = 'perusahaan sudah dibuat pada percobaan sebelumnya (checkpoint) — tidak dibuat ulang';
      } else {
        const w = await rpa.registerWholesaleCustomer({
          companyName,
          picName: str(p.picName) ?? str(p.pic) ?? '',
          npwp: str(p.npwp) ?? '',
          alamat: str(p.alamat) ?? str(p.address) ?? '',
          advisorName: str(p.advisorName) ?? str(p.advisor) ?? '',
          retail: null, // retail runs BELOW, after the checkpoint is written
        });
        companyId = w.companyId;
        companyUrl = w.companyUrl;
        note = w.note ?? null;
        await flowJobs().updateOne(
          { _id: job._id },
          { $set: { progress: { companyId, companyUrl }, updatedAt: new Date().toISOString() } as unknown as Partial<FlowJob> },
        );
      }

      let retail: Record<string, unknown> | null = null;
      if (retailNama) {
        const r = await rpa.registerRetailCustomer({
          nama: retailNama,
          phone: str(rp.phone) ?? str(rp.wa) ?? str(p.phone) ?? str(p.wa) ?? '',
          alamat: str(rp.alamat) ?? str(p.alamat) ?? str(p.address) ?? '',
          storeTurbolyId,
          companyName,
        });
        retail = { ...r };
      }
      return { companyId, companyUrl, ...(retail ? { retail } : {}), ...(note ? { note } : {}) };
    }
  }
}

// ── claim / drain loop ─────────────────────────────────────────────────────

async function claimJob(onlyId: string | undefined): Promise<FlowJob | null> {
  if (onlyId) {
    const now = new Date().toISOString();
    const res = await flowJobs().findOneAndUpdate(
      { _id: onlyId, state: 'queued' },
      { $set: { state: 'running', startedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    return res ?? null;
  }
  return claimNextFlowJob();
}

async function main(): Promise<void> {
  const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  await connect(config.mongoUri, config.mongoDb);
  // createIndexes is a full Atlas round trip paid on EVERY invocation (a */5
  // cron plus one dispatch per board click) and nothing below waits on it:
  // flow_jobs is small, so a missing ix_flow_queue costs the claim a scan, not
  // a stall. Overlap it with the first claim rather than gating on it.
  const indexesReady = ensureFlowIndexes().catch((e: unknown) => {
    console.warn(`flow-once: ensureFlowIndexes failed (ignored) — ${e instanceof Error ? e.message : String(e)}`);
  });
  const rigs = new BranchFlowRigs();
  console.log(`flow-once: base=${config.turbolyBaseUrl}`);

  let done = 0;
  let failed = 0;
  let requeued = 0;
  const startedAt = Date.now();

  try {
    let graceUntil = 0;
    for (;;) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        console.log('flow-once: time budget reached — exiting (the next run resumes)');
        break;
      }
      const job = await claimJob(onlyId);
      if (!job) {
        // Empty from the start (the cron safety net) → exit now; the runner has
        // nothing to be warm for. Otherwise linger: see GRACE_MS.
        if (onlyId || done + failed + requeued === 0) break;
        if (graceUntil === 0) graceUntil = Date.now() + GRACE_MS;
        if (Date.now() >= graceUntil) break;
        await sleep(GRACE_POLL_MS);
        continue;
      }
      graceUntil = 0; // a job arrived — restart the window, the operator is mid-burst
      const label = `${String(job.action)} spk=${job.spkId || '-'} job=${job._id} attempt=${job.attempts}`;
      console.log(`flow-once: run ${label}`);

      try {
        if (!isFlowAction(job.action)) throw new DataError(`Aksi tidak dikenal: ${String(job.action)}`);
        const action = job.action;
        const params = (job.params ?? {}) as Record<string, unknown>;
        const result = await executeJob(job, action, params, rigs);

        if (job.spkId && result.alreadyDone !== true) {
          // Merge result over params so the patch reads the NORMALIZED values
          // (flowPatchAfter pulls waktu/findings/next-service from `params`).
          const patch = flowPatchAfter(action, { ...params, ...result }, result);
          if (action === 'complete_invoice') {
            const m = str(result.method);
            const a = num(result.amount);
            if (m && a != null && (FLOW_PAYMENT_METHODS as readonly string[]).includes(m)) {
              patch.payment = { method: m as FlowPaymentMethod, amount: a };
            }
          }
          if (Object.keys(patch).length) await updateFlow(job.spkId, patch);
          if (action === 'create_wo') {
            const woNo = str(result.workOrderNo);
            // Mirror into the read-back block (unique-indexed) without clobbering.
            if (woNo) await collections.spk().updateOne({ _id: job.spkId, 'turboly.workOrderNo': null }, { $set: { 'turboly.workOrderNo': woNo } });
          }
        }

        await completeFlowJob(job._id, result);
        if (job.spkId) await emit({ spkId: job.spkId, type: `flow_${job.action}_done`, by: job.by ?? 'flow-worker', data: result });
        done += 1;
        console.log(`flow-once: ok ${label}`);
      } catch (e) {
        let { transient, msg } = classify(e);
        // A kicked session (one Turboly session per user — routine!) surfaces
        // as Discovery/Data errors, not as a typed transient. Probe the live
        // pages: kicked → transient, the retry's ensureLoggedIn re-logs in.
        const isAuth = e instanceof AuthChallengeError || (e instanceof Error && e.name === 'AuthChallengeError');
        // Turboly maintenance windows serve a "site maintenance" page (and
        // "You have been logged out" on XHRs) — transient, but staff deserve
        // the real reason instead of a vague retry loop.
        if (/site maintenance|undergoing scheduled upgrades|logged out\. please login/i.test(msg)) {
          transient = true;
          msg = 'Turboly sedang MAINTENANCE (upgrade terjadwal) — otomatis dilanjutkan setelah Turboly online lagi.';
        }
        if (!transient && !isAuth && (await rigs.anySessionKicked())) {
          transient = true;
          msg = `sesi Turboly ter-kick oleh login lain — dicoba ulang otomatis. (${msg})`;
        }
        const willRetry = transient && job.attempts < (job.maxAttempts ?? FLOW_JOB_MAX_ATTEMPTS);
        await failFlowJob(job._id, msg, { transient });
        if (job.spkId) {
          const ts = new Date().toISOString();
          await collections.spk().updateOne({ _id: job.spkId }, { $set: { 'flow.lastError': msg, 'flow.lastErrorAt': ts, updatedAt: ts } });
        }
        if (willRetry) requeued += 1;
        else failed += 1;
        console.error(`flow-once: FAIL(${transient ? 'transient' : 'permanent'}) ${label} — ${msg}`);
      }

      if (onlyId) break;
    }
  } finally {
    await rigs.dispose();
    await indexesReady;
    await close();
  }

  console.log(`flow-once: ${done} done, ${requeued} requeued (transient), ${failed} failed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
