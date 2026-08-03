import { collections, transition, loadMirror } from '@spk/core';
import { buildTurbolyPayload, planFromNowWib, formatDateWib, formatTimeWib } from '@spk/core/turboly';
import type { BranchSinks } from './sessions.js';
import { config } from './config.js';

/**
 * The proven, Redis-free push path — one pass over `queued` SPKs.
 *
 * This is the exact sequence validated live (created SRO/BKS/26080002+3):
 *   CAS queued→pushing → build payload (future plan time) → RPA push →
 *   pushed → independent read-back → confirmed.
 *
 * Both entrypoints share it: `push-once` runs it once and exits; `push-loop`
 * runs it forever on a poll interval. Neither needs BullMQ/Redis.
 */

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export interface RunResult {
  candidates: number;
  pushed: number;
  confirmed: number;
  failed: number;
}

/** Process every `queued` SPK (or a single `onlyId`). Returns per-pass counts. */
export async function pushQueued(
  branchSinks: BranchSinks,
  opts: { workerId?: string; onlyId?: string; limit?: number; log?: (m: string) => void } = {},
): Promise<RunResult> {
  const workerId = opts.workerId ?? 'push-runner';
  const log = opts.log ?? (() => {});
  const out: RunResult = { candidates: 0, pushed: 0, confirmed: 0, failed: 0 };

  // Requeue transient failures that are due for retry (bounded). Data failures
  // (no Turboly match, bad SKU) are left for a human — retrying won't help.
  const MAX_ATTEMPTS = 5;
  if (!opts.onlyId) {
    const nowIso = new Date().toISOString();
    const retryable = await collections
      .spk()
      .find({ state: 'failed', 'push.attempt': { $lt: MAX_ATTEMPTS }, 'push.nextAttemptAt': { $lte: nowIso }, 'push.failureClass': { $nin: ['data'] } })
      .limit(opts.limit ?? 25)
      .toArray();
    for (const d of retryable) {
      const r = await transition(d._id, 'failed', 'queued', {}).catch(() => null);
      if (r) log(`↻ requeued ${d._id} (attempt ${d.push.attempt}, was ${d.push.failureClass ?? '?'})`);
    }

    // Reclaim orphans: a runner killed mid-push (job timeout, crash) leaves its
    // doc in `pushing` with a dead lease — nothing else ever touches it. Any
    // pushing doc untouched for 15+ minutes has no living runner (leases are
    // far shorter); CAS it back to queued so this run re-pushes it.
    const staleIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const orphans = await collections
      .spk()
      .find({ state: 'pushing', updatedAt: { $lt: staleIso } })
      .limit(opts.limit ?? 25)
      .toArray();
    for (const d of orphans) {
      const r = await transition(d._id, 'pushing', 'queued', {}).catch(() => null);
      if (r) log(`↻ reclaimed orphan ${d._id} (pushing since ${d.updatedAt} — runner died mid-push)`);
    }
  }

  const filter = opts.onlyId ? { _id: opts.onlyId } : { state: 'queued' as const };
  const docs = await collections.spk().find(filter).limit(opts.limit ?? 25).toArray();
  out.candidates = docs.length;
  if (docs.length === 0) return out;

  for (const doc of docs) {
    if (doc.state !== 'queued') { log(`· skip ${doc._id} (state=${doc.state})`); continue; }
    const epoch = doc.push.lease.epoch + 1;
    const leaseExpiresAt = Date.now() + config.leaseTtlMs;
    const claimed = await transition(doc._id, 'queued', 'pushing', {
      push: { ...doc.push, attempt: doc.push.attempt + 1, lease: { workerId, epoch, expiresAt: new Date(leaseExpiresAt).toISOString() } },
    });
    if (!claimed) { log(`· skip ${doc._id} (lost CAS)`); continue; }

    try {
      const mirror = await loadMirror(claimed.branchCode);
      if (!mirror.store) throw new Error(`store ${claimed.branchCode} not in mirror (run seed:turboly)`);
      // Advisor: prefer a mirror match; otherwise DON'T fail — pass the typed name
      // through so the RPA tries it as a Turboly label and falls back to the first
      // real advisor if it isn't an exact match. Keeps any form input pushable.
      const typedAdvisor = (claimed.signatures.menerima.namaJelas ?? '').trim();
      const advisor =
        mirror.advisorByName.get(norm(typedAdvisor)) ??
        [...mirror.advisorByName.values()][0] ??
        { _id: 'unmatched', mechanicCode: 'unmatched', name: typedAdvisor || 'Advisor', storeCode: null, role: 'advisor', syncedAt: '' };
      if (!mirror.advisorByName.get(norm(typedAdvisor))) {
        log(`  · advisor "${typedAdvisor}" not in mirror — letting Turboly pick a matching/first advisor`);
      }
      // Plan Service Date/Time: a FUTURE appointment (scheduledAt) wins; else
      // walk-in semantics = now+30min WIB (Turboly requires plan time > "now").
      const sched = claimed.scheduledAt && Date.parse(claimed.scheduledAt) > Date.now() + 5 * 60_000 ? claimed.scheduledAt : null;
      const plan = sched
        ? { date: formatDateWib(sched), time: formatTimeWib(sched) }
        : planFromNowWib(30);
      const payload = buildTurbolyPayload({ doc: claimed, store: mirror.store, serviceProducts: mirror.serviceProducts, serviceAdvisor: advisor, salesperson: advisor, planServiceDate: plan.date, planServiceTime: plan.time });

      const res = await branchSinks.withSink(claimed.branchCode, (sink) =>
        sink.pushServiceOrder(payload, { workerId, epoch, approve: config.approveAfterSave, leaseExpiresAt }),
      );
      if (!res.ok) {
        out.failed++;
        await transition(doc._id, 'pushing', 'failed', {
          push: { ...claimed.push, failureClass: res.failureClass ?? 'structural', lastError: res.error ?? 'push failed', nextAttemptAt: new Date(Date.now() + 60_000).toISOString() },
        }).catch(() => {});
        log(`✗ ${doc._id}: [${res.failureClass ?? '?'}] ${res.error ?? ''}`);
        continue;
      }
      const pushedTurboly = { ...claimed.turboly, serviceOrderNo: res.serviceOrderNo, serviceOrderUrl: res.serviceOrderUrl ?? null };
      await transition(doc._id, 'pushing', 'pushed', { turboly: pushedTurboly });
      out.pushed++;
      log(`✓ ${doc._id} → Service Order ${res.serviceOrderNo}`);

      const v = await branchSinks.withSink(claimed.branchCode, (sink) =>
        sink.verifyByToken({ ...claimed, turboly: pushedTurboly }),
      );
      if (v.found) {
        await transition(doc._id, 'pushed', 'confirmed', {
          turboly: { ...pushedTurboly, serviceOrderNo: v.serviceOrderNo, readback: { matchedOn: ['reference_token'], lineCount: v.lineCount, lineSkus: v.lineSkus, km: v.km } },
        });
        out.confirmed++;
        log(`  ✓ verified → confirmed`);
      } else {
        log(`  ⚠ not verified (left in 'pushed')`);
      }
    } catch (e) {
      out.failed++;
      await transition(doc._id, 'pushing', 'failed', {
        push: { ...claimed.push, failureClass: 'structural', lastError: String((e as Error).message ?? e), nextAttemptAt: new Date(Date.now() + 60_000).toISOString() },
      }).catch(() => {});
      log(`✗ ${doc._id}: ${(e as Error).message ?? e}`);
    }
  }
  return out;
}
