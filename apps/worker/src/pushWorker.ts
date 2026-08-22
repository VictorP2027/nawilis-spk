import { collections, transition, emit, loadMirror, claimId } from '@spk/core';
import type { SpkDoc, FailureClass } from '@spk/core';
import { buildTurbolyPayload, planFromNowWib, type ServiceOrderSink } from '@spk/core/turboly';
import { config } from './config.js';
import { backoffMs } from './util.js';
import { AuthBreaker, StructuralBreaker } from './breaker.js';
import { DegradationController } from './degradation.js';
import { BranchSinks } from './sessions.js';
import { enqueueVerify, type PushJob } from './queue.js';
import { fireAlert } from './alerts.js';
import { lookupPerson } from '@spk/core';

const SUPPORTED_SCHEMA = { min: 1, max: 1 };

/**
 * The push worker. One job = one SPK's Service Order create. Safety:
 *  - CAS queued→pushing acquires a fencing lease (workerId, epoch, expiresAt).
 *  - Per-branch mutex ⇒ one job per branch account touches the session at a time.
 *  - Claim table (unique on correlationToken+phase) is a second guard against
 *    a duplicate SO and the store of the resulting Turboly doc number.
 *  - Failures are CLASSIFIED, not blanket-retried.
 */
export class PushWorker {
  private workerId = `w-${process.pid}-${Math.floor(process.uptime() * 1000)}`;

  constructor(
    private readonly branchSinks: BranchSinks,
    private readonly authBreaker: AuthBreaker,
    private readonly structuralBreaker: StructuralBreaker,
    private readonly degradation: DegradationController,
  ) {}

  /** BullMQ processor. */
  async process(job: PushJob): Promise<void> {
    if (this.structuralBreaker.isOpen()) return; // stay queued
    if (this.authBreaker.isOpen(job.branchCode)) return;
    if (!this.degradation.automationActive()) return; // rung ≥ 2: humans handle it
    // withSink serialises per branch (single session, page concurrency 1).
    await this.branchSinks.withSink(job.branchCode, (sink) => this.processLocked(job, sink));
  }

  private async processLocked(job: PushJob, sink: ServiceOrderSink): Promise<void> {
    const doc = await collections.spk().findOne({ _id: job.spkId });
    if (!doc) return;

    // Schema-version guard — fail closed, loudly. A worker must never push a doc
    // whose shape it doesn't fully understand (risk: SO with no billable lines).
    if (doc.schemaVersion < SUPPORTED_SCHEMA.min || doc.schemaVersion > SUPPORTED_SCHEMA.max) {
      await transition(doc._id, doc.state, 'manual_intervention', { push: { ...doc.push, lastError: 'SCHEMA_VERSION_OUT_OF_RANGE' } }).catch(() => null);
      await fireAlert({ level: 'page', code: 'SCHEMA_VERSION', branchCode: doc.branchCode, message: `SPK ${doc._id} schemaVersion ${doc.schemaVersion} unsupported` });
      return;
    }

    // Acquire the lease via CAS queued → pushing.
    const epoch = doc.push.lease.epoch + 1;
    const now = Date.now();
    const leaseExpiresAt = now + config.leaseTtlMs;
    const claimed = await transition(doc._id, 'queued', 'pushing', {
      push: {
        ...doc.push,
        attempt: doc.push.attempt + 1,
        claimedAt: new Date(now).toISOString(),
        lease: { workerId: this.workerId, epoch, expiresAt: new Date(leaseExpiresAt).toISOString() },
      },
    });
    if (!claimed) return; // lost the CAS — another worker has it

    // Claim-table guard for the ORDER phase.
    const orderClaimId = claimId(doc._id, 'order');
    try {
      await collections.turbolyDocs().insertOne({
        _id: orderClaimId,
        spkId: doc._id,
        phase: 'order',
        correlationToken: doc.push.correlationToken,
        claimedBy: this.workerId,
        epoch,
        claimedAt: new Date(now).toISOString(),
        committedAt: null,
        turbolyDocNo: null,
      });
    } catch {
      // A claim already exists — a prior attempt may have created the SO. Verify
      // before ever recreating (never double-create), then adopt or reset.
      await this.handleExistingClaim(claimed, orderClaimId, sink);
      return;
    }

    // Build the fully-resolved payload from the mirror.
    const mirror = await loadMirror(doc.branchCode, { withProductSkus: true });
    if (!mirror.store) {
      await this.toManual(claimed, 'store not in mirror at push time');
      return;
    }
    // Service advisor / salesperson names were validated at Layer 2 and stored on
    // the doc's menerima signature; resolve against the mirror.
    const advisor = resolveMechanic(mirror, doc.signatures.menerima.namaJelas);
    if (!advisor) {
      await this.toManual(claimed, 'service advisor/salesperson not resolvable in mirror');
      return;
    }
    const salesperson = advisor; // Nawilis: advisor doubles as salesperson unless configured otherwise

    const plan = planFromNowWib(30); // Turboly rejects a plan time <= server "now"
    const payload = buildTurbolyPayload({
      doc: claimed,
      store: mirror.store,
      serviceProducts: mirror.serviceProducts, productSkus: mirror.productSkus,
      serviceAdvisor: advisor,
      salesperson,
      planServiceDate: plan.date,
      planServiceTime: plan.time,
    });

    // Drive the sink.
    const result = await sink.pushServiceOrder(payload, {
      workerId: this.workerId,
      epoch,
      approve: config.approveAfterSave,
      leaseExpiresAt,
    });

    if (result.ok) {
      this.authBreaker.recordSuccess(doc.branchCode);
      this.structuralBreaker.recordNonStructuralOutcome();
      await collections.turbolyDocs().updateOne(
        { _id: orderClaimId },
        { $set: { committedAt: new Date().toISOString(), turbolyDocNo: result.serviceOrderNo } },
      );
      await transition(doc._id, 'pushing', 'pushed', {
        turboly: { ...claimed.turboly, serviceOrderNo: result.serviceOrderNo, serviceOrderUrl: result.serviceOrderUrl ?? null },
        push: { ...claimed.push, phases: { ...claimed.push.phases, order: { status: 'committed', at: new Date().toISOString(), turbolyDocNo: result.serviceOrderNo } }, failureClass: null, lastError: null },
      });
      await emit({ spkId: doc._id, type: 'pushed', by: this.workerId, data: { serviceOrderNo: result.serviceOrderNo, screenshotRef: result.screenshotRef } });
      // Verification runs separately (fresh context). Always verify; at rung 1
      // the sampled audit is an ADDITIONAL human check, not a replacement.
      await enqueueVerify({ spkId: doc._id, branchCode: doc.branchCode });
      return;
    }

    // Failure path — classify and route.
    await this.handleFailure(claimed, orderClaimId, result.failureClass ?? 'structural', result.error ?? 'unknown');
  }

  private async handleFailure(doc: SpkDoc, orderClaimId: string, cls: FailureClass, error: string): Promise<void> {
    // Remove the uncommitted claim so a legitimate retry can re-create.
    await collections.turbolyDocs().deleteOne({ _id: orderClaimId, committedAt: null }).catch(() => {});

    const commonSet = { push: { ...doc.push, failureClass: cls, lastError: error } };

    /**
     * A session kicked by ANOTHER login costs this document nothing.
     *
     * Turboly allows one session per account, so any other holder logging in ends
     * ours mid-write — and the document that happened to be in flight took the
     * blame. It burned an attempt each time, and after maxAttempts a perfectly
     * good SPK landed in manual_intervention waiting for someone to press "Coba
     * lagi", for a fault that was never about the document and always clears by
     * itself. So the attempt is handed back and it retries on the normal requeue
     * sweep, exactly as an auth failure already does.
     *
     * Safe against a retry loop: this only rolls back a failure that names a kick,
     * every other transient still spends its budget and still reaches the DLQ, and
     * the requeue sweep is the only thing that resurrects it — so it retries on the
     * queue's own clock, not in a tight loop.
     */
    if (cls === 'transient' && /ter-kick|kicked/i.test(error)) {
      await transition(doc._id, 'pushing', 'failed', {
        push: {
          ...doc.push,
          attempt: Math.max(0, doc.push.attempt - 1),
          failureClass: cls,
          lastError: error,
          nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      return;
    }

    switch (cls) {
      case 'auth': {
        await this.authBreaker.recordFailure(doc.branchCode);
        // Do NOT consume the retry budget for auth — re-auth once next attempt.
        await transition(doc._id, 'pushing', 'failed', { push: { ...doc.push, failureClass: cls, lastError: error, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() } });
        return;
      }
      case 'infra': {
        // Turboly deploy / DNS / 5xx — retry with backoff, NEVER count toward a breaker.
        await this.scheduleRetry(doc, cls, error);
        return;
      }
      case 'transient': {
        this.structuralBreaker.recordNonStructuralOutcome();
        await this.scheduleRetry(doc, cls, error);
        return;
      }
      case 'data': {
        // Permanent for THIS record → DLQ, no retry. The cross-branch detector
        // (below) escalates to structural if the same error hits many records.
        await this.structuralBreaker.recordStructuralFailure(doc.branchCode, error); // feeds identical-error discriminator
        await this.toDlq(doc, 'data', error);
        await transition(doc._id, 'pushing', 'manual_intervention', commonSet);
        await fireAlert({ level: 'ops', code: 'DLQ_DATA', branchCode: doc.branchCode, message: `${doc._id}: ${error}` });
        return;
      }
      case 'structural':
      default: {
        await this.structuralBreaker.recordStructuralFailure(doc.branchCode, error);
        // One cheap retry, then DLQ + keep it recoverable (not terminal).
        if (doc.push.attempt <= 1) {
          await this.scheduleRetry(doc, 'structural', error, 5000);
        } else {
          await this.toDlq(doc, 'structural', error);
          await transition(doc._id, 'pushing', 'failed', { push: { ...doc.push, failureClass: cls, lastError: error, nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() } });
          await fireAlert({ level: 'page', code: 'DLQ_STRUCTURAL', branchCode: doc.branchCode, message: `${doc._id}: ${error}` });
        }
        return;
      }
    }
  }

  private async scheduleRetry(doc: SpkDoc, cls: FailureClass, error: string, fixedMs?: number): Promise<void> {
    if (doc.push.attempt >= doc.push.maxAttempts) {
      await this.toDlq(doc, cls, `max attempts: ${error}`);
      await transition(doc._id, 'pushing', 'manual_intervention', { push: { ...doc.push, failureClass: cls, lastError: error } });
      await fireAlert({ level: 'ops', code: 'MAX_ATTEMPTS', branchCode: doc.branchCode, message: `${doc._id}: ${error}` });
      return;
    }
    const delay = fixedMs ?? backoffMs(doc.push.attempt);
    await transition(doc._id, 'pushing', 'failed', {
      push: { ...doc.push, failureClass: cls, lastError: error, nextAttemptAt: new Date(Date.now() + delay).toISOString() },
    });
  }

  private async toManual(doc: SpkDoc, reason: string): Promise<void> {
    await transition(doc._id, 'pushing', 'manual_intervention', { push: { ...doc.push, lastError: reason } });
    await fireAlert({ level: 'ops', code: 'TO_MANUAL', branchCode: doc.branchCode, message: `${doc._id}: ${reason}` });
  }

  private async toDlq(doc: SpkDoc, failureClass: FailureClass, error: string): Promise<void> {
    await collections.dlq().updateOne(
      { _id: `${doc._id}#order` },
      { $set: { spkId: doc._id, phase: 'order', failureClass, turbolyError: error, attempts: doc.push.attempt, enqueuedAt: new Date().toISOString(), resolvedAt: null } },
      { upsert: true },
    );
  }

  private async handleExistingClaim(doc: SpkDoc, orderClaimId: string, sink: ServiceOrderSink): Promise<void> {
    const claim = await collections.turbolyDocs().findOne({ _id: orderClaimId });
    if (claim?.committedAt && claim.turbolyDocNo) {
      // Already created — adopt and move to verify.
      await transition(doc._id, 'pushing', 'pushed', { turboly: { ...doc.turboly, serviceOrderNo: claim.turbolyDocNo } }).catch(() => null);
      await enqueueVerify({ spkId: doc._id, branchCode: doc.branchCode });
      return;
    }
    // Uncommitted claim from a crashed attempt: verify-before-recreate.
    const v = await sink.verifyByToken(doc).catch(() => null);
    if (v?.found) {
      await collections.turbolyDocs().updateOne({ _id: orderClaimId }, { $set: { committedAt: new Date().toISOString(), turbolyDocNo: v.serviceOrderNo } });
      await transition(doc._id, 'pushing', 'pushed', { turboly: { ...doc.turboly, serviceOrderNo: v.serviceOrderNo } }).catch(() => null);
      await enqueueVerify({ spkId: doc._id, branchCode: doc.branchCode });
      return;
    }
    // Not found and not committed → stale claim; clear it and retry soon.
    await collections.turbolyDocs().deleteOne({ _id: orderClaimId, committedAt: null }).catch(() => {});
    await transition(doc._id, 'pushing', 'failed', { push: { ...doc.push, nextAttemptAt: new Date(Date.now() + 30_000).toISOString() } }).catch(() => null);
  }
}

function resolveMechanic(mirror: Awaited<ReturnType<typeof loadMirror>>, name: string | null | undefined) {
  if (!name) return null;
  return lookupPerson(mirror.advisorByName, name);
}
