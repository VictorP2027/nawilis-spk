import { collections, transition, loadMirror } from '@spk/core';
import { buildTurbolyPayload, planFromNowWib } from '@spk/core/turboly';
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
      const advisor = mirror.advisorByName.get(norm(claimed.signatures.menerima.namaJelas));
      if (!advisor) throw new Error(`advisor "${claimed.signatures.menerima.namaJelas}" not in mirror`);
      const plan = planFromNowWib(30); // Turboly requires plan time > server "now"
      const payload = buildTurbolyPayload({ doc: claimed, store: mirror.store, serviceProducts: mirror.serviceProducts, serviceAdvisor: advisor, salesperson: advisor, planServiceDate: plan.date, planServiceTime: plan.time });

      const res = await branchSinks.withSink(claimed.branchCode, (sink) =>
        sink.pushServiceOrder(payload, { workerId, epoch, approve: config.approveAfterSave, leaseExpiresAt }),
      );
      if (!res.ok) throw new Error(`push failed [${res.failureClass}]: ${res.error}`);
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
        push: { ...claimed.push, lastError: String((e as Error).message ?? e), nextAttemptAt: new Date(Date.now() + 60_000).toISOString() },
      }).catch(() => {});
      log(`✗ ${doc._id}: ${(e as Error).message ?? e}`);
    }
  }
  return out;
}
