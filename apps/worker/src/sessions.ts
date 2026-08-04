import { createSink, type ServiceOrderSink } from '@spk/core/turboly';
import { config } from './config.js';
import { Mutex, MutexRegistry } from './util.js';

/**
 * Owns the process's ONE Turboly sink (= one browser session for RPA), plus a
 * per-branch mutex so a write and its later read-back are temporally separated
 * on the same session (fresh navigation each time), never concurrent.
 *
 * Turboly allows ONE SESSION PER USER and every branch authenticates with the
 * SAME .env credentials, so keeping a sink alive per branch was self-harm: each
 * new branch's login instantly kicked the sinks already open, and the kicked one
 * then met a sign-in page mid-action ("sesi Turboly ter-kick"). Hence a single
 * live sink — moving to another branch disposes it BEFORE logging in, and the
 * gate below keeps two branches from being mid-operation across that swap.
 * A swap costs a fresh login, so consecutive work on one branch reuses the sink.
 */
export type SinkFactory = (branchCode: string) => Promise<ServiceOrderSink>;

export class BranchSinks {
  private live: { branchCode: string; sink: ServiceOrderSink } | null = null;
  private mutexes = new MutexRegistry();
  /** Only one branch may be mid-operation — otherwise a swap kills its session. */
  private gate = new Mutex();

  /** Optional factory injection for tests; defaults to the real createSink. */
  constructor(private readonly factory?: SinkFactory) {}

  private async sinkFor(branchCode: string): Promise<ServiceOrderSink> {
    if (this.live?.branchCode === branchCode) return this.live.sink;
    if (this.live) {
      // Dispose FIRST: the new login would kick this one anyway, and a dead
      // session left in the map is what produced the mid-action sign-in pages.
      const stale = this.live;
      this.live = null;
      await stale.sink.dispose?.().catch(() => {});
    }
    const sink = this.factory
      ? await this.factory(branchCode)
      : await createSink({
          mode: config.pushMode,
          branchCode,
          baseUrl: config.turbolyBaseUrl,
          stateDir: config.turbolyStateDir,
          userAgentSuffix: config.userAgentSuffix,
          screenshotDir: config.screenshotDir,
        });
    this.live = { branchCode, sink };
    return sink;
  }

  /**
   * Run fn with the branch's sink, holding the branch mutex for its duration.
   * Lock order is branch-then-gate everywhere (the gate is always innermost),
   * so waiters can never form a cycle.
   */
  async withSink<T>(branchCode: string, fn: (sink: ServiceOrderSink) => Promise<T>): Promise<T> {
    return this.mutexes.get(branchCode).run(() =>
      this.gate.run(async () => fn(await this.sinkFor(branchCode))),
    );
  }

  /** For the canary: the live branch (at most one) — probing it costs no login. */
  branches(): string[] {
    return this.live ? [this.live.branchCode] : [];
  }

  async dispose(): Promise<void> {
    const live = this.live;
    this.live = null;
    await live?.sink.dispose?.().catch(() => {});
  }
}
