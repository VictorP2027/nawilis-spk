import { collections, transition, loadMirror } from '@spk/core';
import { buildTurbolyPayload, planFromNowWib, formatDateWib, formatTimeWib } from '@spk/core/turboly';
import type { BranchSinks } from './sessions.js';
import { config } from './config.js';

/**
 * The proven, Redis-free push path — drains `queued` SPKs until the queue is
 * empty or the budget runs out.
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

/**
 * push.yml caps the job at 60 minutes. Stop CLAIMING new orders at 50 so the
 * process finishes on its own terms: a runner killed mid-push leaves its doc
 * stranded in `pushing` until the 15-minute orphan reclaim below notices.
 */
const DEFAULT_BUDGET_MS = 50 * 60_000;

type Mirror = Awaited<ReturnType<typeof loadMirror>>;

/** Process every `queued` SPK (or a single `onlyId`). Returns per-run counts. */
export async function pushQueued(
  branchSinks: BranchSinks,
  opts: { workerId?: string; onlyId?: string; limit?: number; budgetMs?: number; log?: (m: string) => void } = {},
): Promise<RunResult> {
  const workerId = opts.workerId ?? 'push-runner';
  const log = opts.log ?? (() => {});
  const out: RunResult = { candidates: 0, pushed: 0, confirmed: 0, failed: 0 };
  const pageSize = opts.limit ?? 25;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

  const fetchBatch = () =>
    collections
      .spk()
      .find(opts.onlyId ? { _id: opts.onlyId } : { state: 'queued' as const })
      .limit(pageSize)
      .toArray();

  /**
   * loadMirror is four queries, and three of them are full collection scans —
   * tb_service_products / tb_mechanics / service_sku_map carry no index (see
   * ensureIndexes, which only indexes spk/vehicles/events/dlq). Running it once
   * per DOCUMENT meant a 25-doc pass paid 100 queries and 75 scans for data
   * that is identical whenever the docs share a branch, which they usually do.
   * Cached per CALL and never at module scope: sync.yml rewrites the tb_*
   * mirror hourly and push-loop lives for days, so a longer-lived cache would
   * keep pushing yesterday's advisors.
   */
  const mirrors = new Map<string, Promise<Mirror>>();
  const mirrorFor = (branchCode: string): Promise<Mirror> => {
    let m = mirrors.get(branchCode);
    if (!m) {
      // Drop a rejected load so the next doc retries instead of inheriting a
      // cached failure from one bad Atlas moment.
      m = loadMirror(branchCode).catch((e: unknown) => {
        mirrors.delete(branchCode);
        throw e;
      });
      mirrors.set(branchCode, m);
    }
    return m;
  };

  // Requeue transient failures that are due for retry (bounded). Data failures
  // (no Turboly match, bad SKU) are left for a human — retrying won't help.
  const MAX_ATTEMPTS = 5;
  let docs: Awaited<ReturnType<typeof fetchBatch>>;
  if (opts.onlyId) {
    docs = await fetchBatch();
  } else {
    const nowIso = new Date().toISOString();
    // Reclaim orphans: a runner killed mid-push (job timeout, crash) leaves its
    // doc in `pushing` with a dead lease — nothing else ever touches it. Any
    // pushing doc untouched for 15+ minutes has no living runner (leases are
    // far shorter); CAS it back to queued so this run re-pushes it.
    const staleIso = new Date(Date.now() - 15 * 60_000).toISOString();
    // Three independent reads that used to run back-to-back. Every one is a
    // fresh Atlas round trip on a cold runner, and they sit in front of the
    // first Turboly byte, so they go together. The queued read rides along
    // speculatively: on a pass with nothing to requeue — nearly all of them —
    // its result IS the batch and the re-read below never happens.
    const [retryable, orphans, queuedNow] = await Promise.all([
      collections
        .spk()
        .find({ state: 'failed', 'push.attempt': { $lt: MAX_ATTEMPTS }, 'push.nextAttemptAt': { $lte: nowIso }, 'push.failureClass': { $nin: ['data'] } })
        .limit(pageSize)
        .toArray(),
      collections.spk().find({ state: 'pushing', updatedAt: { $lt: staleIso } }).limit(pageSize).toArray(),
      fetchBatch(),
    ]);
    // Independent CAS updates on distinct _ids — serialising them cost a round
    // trip each (up to 50 of them) and bought no ordering guarantee.
    const revived = await Promise.all([
      ...retryable.map((d) =>
        transition(d._id, 'failed', 'queued', {})
          .then((r) => (r ? `↻ requeued ${d._id} (attempt ${d.push.attempt}, was ${d.push.failureClass ?? '?'})` : null))
          .catch(() => null),
      ),
      ...orphans.map((d) =>
        // Mark it: a doc that outlived its lease may have been saved in Turboly
        // already, and the claim path must not create a second order for it.
        transition(d._id, 'pushing', 'queued', { push: { ...d.push, reclaimed: true } })
          .then((r) => (r ? `↻ reclaimed orphan ${d._id} (pushing since ${d.updatedAt} — runner died mid-push)` : null))
          .catch(() => null),
      ),
    ]);
    for (const m of revived) if (m) log(m);
    docs = revived.some(Boolean) ? await fetchBatch() : queuedNow;
  }

  /**
   * Docs already attempted by THIS call. The re-read below asks the same
   * question again, so anything we could not claim (lost CAS) would otherwise
   * come back forever — this is what makes the drain terminate.
   */
  const seen = new Set<string>();
  let warmed = false;
  let budgetHit = false;

  for (;;) {
    const batch = docs.filter((d) => !seen.has(d._id));
    if (batch.length === 0) break;
    out.candidates += batch.length;

    for (let i = 0; i < batch.length; i++) {
      const doc = batch[i]!;
      seen.add(doc._id);
      if (Date.now() >= deadline) {
        log(`· time budget reached — ${batch.length - i} left for the next run`);
        budgetHit = true;
        break;
      }
      if (doc.state !== 'queued') { log(`· skip ${doc._id} (state=${doc.state})`); continue; }
      const epoch = doc.push.lease.epoch + 1;
      const leaseExpiresAt = Date.now() + config.leaseTtlMs;
      const claimed = await transition(doc._id, 'queued', 'pushing', {
        push: { ...doc.push, attempt: doc.push.attempt + 1, lease: { workerId, epoch, expiresAt: new Date(leaseExpiresAt).toISOString() } },
      });
      if (!claimed) { log(`· skip ${doc._id} (lost CAS)`); continue; }

      // Launch the browser NOW, in parallel with the mirror load and payload
      // build below. chromium.launch + newContext(storageState) is entirely
      // local — not one byte reaches Turboly until pushServiceOrder logs in —
      // so this neither kicks a live session nor breaks "empty passes never
      // touch Turboly": it only starts after a doc has actually been claimed,
      // which also guarantees it warms the branch we are about to push.
      if (!warmed) {
        warmed = true;
        void branchSinks.withSink(claimed.branchCode, async () => {}).catch(() => {});
      }

      try {
        const mirror = await mirrorFor(claimed.branchCode);
        if (!mirror.store) throw new Error(`store ${claimed.branchCode} not in mirror (run seed:turboly)`);
        // Advisor: exact mirror match wins; otherwise pass the TYPED name through so
        // the RPA tries it as a Turboly label. NEVER auto-pick a random advisor —
        // with no/unknown name the SO field is left at Turboly's own default
        // (misattributed sales credit is worse than an unfilled field).
        const typedAdvisor = (claimed.signatures.menerima.namaJelas ?? '').trim();
        const advisor =
          mirror.advisorByName.get(norm(typedAdvisor)) ??
          { _id: 'unmatched', mechanicCode: 'unmatched', name: typedAdvisor, storeCode: null, role: 'advisor', syncedAt: '' };
        if (!mirror.advisorByName.get(norm(typedAdvisor))) {
          log(`  · advisor "${typedAdvisor || '(kosong)'}" not matched — leaving Turboly's advisor field untouched`);
        }
        // Plan Service Date/Time: a FUTURE appointment (scheduledAt) wins; else
        // walk-in semantics = now+30min WIB (Turboly requires plan time > "now").
        const sched = claimed.scheduledAt && Date.parse(claimed.scheduledAt) > Date.now() + 5 * 60_000 ? claimed.scheduledAt : null;
        const plan = sched
          ? { date: formatDateWib(sched), time: formatTimeWib(sched) }
          : planFromNowWib(30);
        // Salesperson may be a SEPARATE Turboly list (e.g. NWL-BGR): use the form's
        // salesperson when given, else the advisor name; exact-match only — never
        // auto-pick (same policy as advisor).
        const typedSales = (claimed.salespersonName ?? '').trim() || typedAdvisor;
        const salesperson =
          mirror.salespersonByName.get(norm(typedSales)) ??
          { _id: 'unmatched', mechanicCode: 'unmatched', name: typedSales, storeCode: null, role: 'salesperson', syncedAt: '' };
        const payload = buildTurbolyPayload({ doc: claimed, store: mirror.store, serviceProducts: mirror.serviceProducts, serviceAdvisor: advisor, salesperson, planServiceDate: plan.date, planServiceTime: plan.time });

        // VERIFY BEFORE RECREATE. A retry means a previous attempt already ran,
        // and the one thing we cannot know is whether it died before or AFTER
        // Turboly committed the Save — an orphan reclaimed from `pushing` is
        // exactly that case. Pushing blind there creates a SECOND order for one
        // SPK, the worst outcome this pipeline has. The correlation token is on
        // the order, so ask first; only a doc on its first attempt may skip this.
        const wasReclaimed = (claimed.push as { reclaimed?: boolean }).reclaimed === true;
        if (claimed.push.attempt > 1 || wasReclaimed) {
          const prior = await branchSinks
            .withSink(claimed.branchCode, (sink) => sink.verifyByToken(claimed))
            .catch(() => null);
          if (prior?.found) {
            const adopted = { ...claimed.turboly, serviceOrderNo: prior.serviceOrderNo ?? claimed.turboly.serviceOrderNo };
            await transition(doc._id, 'pushing', 'pushed', { turboly: adopted }).catch(() => {});
            await transition(doc._id, 'pushed', 'confirmed', {
              turboly: { ...adopted, readback: { matchedOn: ['reference_token'], lineCount: prior.lineCount, lineSkus: prior.lineSkus, km: prior.km } },
            }).catch(() => {});
            out.pushed++;
            out.confirmed++;
            log(`✓ ${doc._id} sudah ada di Turboly (${prior.serviceOrderNo ?? '?'}) — diadopsi, tidak dibuat ulang`);
            continue;
          }
          if (wasReclaimed) {
            // "Not found" is NOT proof of absence here: without a stored URL the
            // read-back falls back to a list search that can simply miss. A
            // reclaimed doc whose order we cannot SEE has an unknown outcome, and
            // pushing on unknown is how one SPK becomes two Service Orders —
            // which is exactly what happened when this path pushed blind. A human
            // checks Turboly; that is cheap, a duplicate order is not.
            await transition(doc._id, 'pushing', 'manual_intervention', {
              push: {
                ...claimed.push,
                failureClass: 'structural',
                lastError:
                  'Runner mati saat push dan Service Order-nya tidak ditemukan lagi — CEK MANUAL di Turboly (cari nomor referensi SPK ini). Jangan push ulang sebelum yakin ordernya belum ada.',
              },
            }).catch(() => {});
            out.failed++;
            log(`⚠ ${doc._id}: orphan tidak bisa diverifikasi — dipindah ke manual_intervention (hindari order dobel)`);
            continue;
          }
        }

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
        try {
          await transition(doc._id, 'pushing', 'pushed', { turboly: pushedTurboly });
        } catch (e) {
          // Storage refused the read-back keys (the order's identity is already
          // claimed by another doc). The Service Order EXISTS — parking this in
          // manual_intervention is the only safe answer, because a `failed` doc
          // gets retried and the retry would create a SECOND order in Turboly.
          await transition(doc._id, 'pushing', 'manual_intervention', {
            push: {
              ...claimed.push,
              failureClass: 'structural',
              lastError: `SO ${res.serviceOrderNo} (${res.serviceOrderUrl ?? '-'}) sudah diklaim dokumen lain di Mongo — JANGAN retry, order sudah ada di Turboly: ${(e as Error).message ?? e}`,
            },
          }).catch(() => {});
          out.failed++;
          log(`⚠ ${doc._id}: SO ${res.serviceOrderNo} sudah diklaim dokumen lain — dipindah ke manual_intervention (order sudah ada, jangan retry)`);
          continue;
        }
        out.pushed++;
        log(`✓ ${doc._id} → Service Order ${res.serviceOrderNo}${res.approved === false ? ' ⚠ MASIH DRAFT (approve tidak terkonfirmasi)' : res.approved ? ' [APPROVED]' : ''}`);

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

    if (budgetHit || opts.onlyId) break;
    // An SPK assigned WHILE this batch was pushing used to wait for the next
    // */5 cron plus another 60-90s runner cold start, because the candidate
    // list was read once and never again. This runner is already alive and
    // already logged in, so re-ask before letting it die. Terminates on the
    // `seen` filter above (and the budget).
    if (Date.now() >= deadline) break;
    docs = await fetchBatch();
  }

  return out;
}
