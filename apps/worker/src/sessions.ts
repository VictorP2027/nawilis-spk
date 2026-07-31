import { createSink, type ServiceOrderSink } from '@spk/core/turboly';
import { config } from './config.js';
import { MutexRegistry } from './util.js';

/**
 * Owns one Turboly sink (= one browser session for RPA) per branch, and a
 * per-branch mutex so only one operation touches a branch's single account
 * session at a time. Both the push worker and the verifier go through here — so
 * a write and its later read-back are temporally separated on the SAME session
 * (fresh navigation each time), never two concurrent logins to one account.
 */
export type SinkFactory = (branchCode: string) => Promise<ServiceOrderSink>;

export class BranchSinks {
  private sinks = new Map<string, ServiceOrderSink>();
  private mutexes = new MutexRegistry();

  /** Optional factory injection for tests; defaults to the real createSink. */
  constructor(private readonly factory?: SinkFactory) {}

  private async sinkFor(branchCode: string): Promise<ServiceOrderSink> {
    let s = this.sinks.get(branchCode);
    if (!s) {
      s = this.factory
        ? await this.factory(branchCode)
        : await createSink({
            mode: config.pushMode,
            branchCode,
            baseUrl: config.turbolyBaseUrl,
            stateDir: config.turbolyStateDir,
            userAgentSuffix: config.userAgentSuffix,
            screenshotDir: config.screenshotDir,
          });
      this.sinks.set(branchCode, s);
    }
    return s;
  }

  /** Run fn with the branch's sink, holding the branch mutex for its duration. */
  async withSink<T>(branchCode: string, fn: (sink: ServiceOrderSink) => Promise<T>): Promise<T> {
    return this.mutexes.get(branchCode).run(async () => fn(await this.sinkFor(branchCode)));
  }

  /** For the canary: touch each branch's sink without holding it for long. */
  branches(): string[] {
    return [...this.sinks.keys()];
  }

  async dispose(): Promise<void> {
    for (const s of this.sinks.values()) await s.dispose?.().catch(() => {});
    this.sinks.clear();
  }
}
