import { collections } from '@spk/core';
import type { DegradationState } from '@spk/core';
import { fireAlert } from './alerts.js';

/**
 * Degradation ladder. Descends AUTOMATICALLY, ascends ONLY with a human. That
 * asymmetry is deliberate: if the UI changed, a person looks at the fix before
 * hundreds of queued records replay against it.
 *
 *   0 Full auto
 *   1 Sampled audit (auto-push continues + % human read-back audit)
 *   2 Assisted entry (stop driving browser; HO recovery desk works worksheets)
 *   3 Manual (Turboly unreachable / creds revoked / vendor asked us to stop)
 *
 * Anti-flap: 15-min minimum dwell before descending further.
 */
const MIN_DWELL_MS = 15 * 60_000;

export class DegradationController {
  private state: DegradationState = {
    _id: 'degradation',
    rung: 0,
    since: new Date().toISOString(),
    reason: 'init',
    lastCanaryHash: null,
    lastCanaryOkAt: null,
    updatedAt: new Date().toISOString(),
  };

  async load(): Promise<void> {
    const found = await collections.degradation().findOne({ _id: 'degradation' });
    if (found) this.state = found;
    else await this.persist();
  }

  get rung(): 0 | 1 | 2 | 3 {
    return this.state.rung;
  }

  /** Push automation runs at rung 0 and 1 (with audit); 2 and 3 stop driving the browser. */
  automationActive(): boolean {
    return this.state.rung <= 1;
  }

  /** At rung 1, sample this fraction of pushes for human read-back audit. */
  auditFraction(): number {
    return this.state.rung === 1 ? 0.2 : 0;
  }

  private async setRung(rung: 0 | 1 | 2 | 3, reason: string): Promise<void> {
    if (rung === this.state.rung) return;
    const descending = rung > this.state.rung;
    if (descending && Date.now() - Date.parse(this.state.since) < MIN_DWELL_MS && this.state.rung > 0) {
      return; // anti-flap: hold before descending further
    }
    const from = this.state.rung;
    this.state = { ...this.state, rung, since: new Date().toISOString(), reason, updatedAt: new Date().toISOString() };
    await this.persist();
    await fireAlert({
      level: rung >= 2 ? 'page' : 'ops',
      code: descending ? 'DEGRADE' : 'RECOVER',
      message: `Rung ${from} → ${rung}: ${reason}`,
    });
  }

  async descendTo(rung: 1 | 2 | 3, reason: string): Promise<void> {
    if (rung > this.state.rung) await this.setRung(rung, reason);
  }

  /** Human-initiated ascent. Requires the caller to have checked canary-green. */
  async ascendTo(rung: 0 | 1 | 2, reason: string, operator: string): Promise<void> {
    if (rung < this.state.rung) await this.setRung(rung, `${reason} (resumed by ${operator})`);
  }

  async recordCanary(ok: boolean, hash: string): Promise<void> {
    this.state.lastCanaryHash = hash;
    if (ok) this.state.lastCanaryOkAt = new Date().toISOString();
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await collections.degradation().updateOne({ _id: 'degradation' }, { $set: this.state }, { upsert: true });
  }
}
