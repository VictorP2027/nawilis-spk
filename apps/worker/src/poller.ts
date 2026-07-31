import { collections, transition } from '@spk/core';
import { config, inPushWindow } from './config.js';
import { enqueuePush } from './queue.js';
import type { StructuralBreaker } from './breaker.js';
import type { DegradationController } from './degradation.js';

/**
 * The poller is the CORRECTNESS mechanism (change streams are only a latency
 * optimisation). A periodic sweep over the queue index re-enqueues everything
 * eligible, so wiping Redis loses nothing — the truth is in Mongo.
 *
 * It enqueues ONLY records in `queued` state — which, by the assignment gate,
 * means only jobs that have been given to a mechanic. Parked (awaiting_assignment)
 * and declined (voided) records are never seen here.
 *
 * Round-robins across branches so one branch's backlog can't starve the others.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly breaker: StructuralBreaker,
    private readonly degradation: DegradationController,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep().catch((e) => console.error('poll sweep error', e)), config.pollIntervalMs);
    void this.sweep();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // Gate: business-hours window, structural breaker, degradation rung.
    if (!inPushWindow()) return;
    if (this.breaker.isOpen()) return; // while open, jobs stay queued — do not enqueue
    if (!this.degradation.automationActive()) return; // rung ≥ 2: humans handle it

    const now = new Date().toISOString();

    // Promote due `failed` records back to `queued` for retry (CAS each).
    const retryable = await collections
      .spk()
      .find(
        { state: 'failed', 'push.nextAttemptAt': { $lte: now } },
        { projection: { _id: 1 }, limit: 500 },
      )
      .toArray();
    for (const r of retryable) {
      await transition(r._id, 'failed', 'queued').catch(() => null);
    }

    const due = await collections
      .spk()
      .find(
        { state: 'queued', 'push.nextAttemptAt': { $lte: now } },
        { projection: { _id: 1, branchCode: 1, 'push.priority': 1 }, sort: { 'push.priority': -1, 'push.nextAttemptAt': 1 }, limit: 500 },
      )
      .toArray();

    // Round-robin by branch: interleave so high-volume branches don't monopolise.
    const byBranch = new Map<string, typeof due>();
    for (const d of due) {
      const arr = byBranch.get(d.branchCode) ?? [];
      arr.push(d);
      byBranch.set(d.branchCode, arr);
    }
    const branches = [...byBranch.keys()];
    let added = 0;
    let round = 0;
    while (added < due.length) {
      let anyThisRound = false;
      for (const b of branches) {
        const arr = byBranch.get(b)!;
        const item = arr[round];
        if (!item) continue;
        anyThisRound = true;
        await enqueuePush({ spkId: item._id, branchCode: item.branchCode });
        added++;
      }
      if (!anyThisRound) break;
      round++;
    }
  }
}
