import { fireAlert } from './alerts.js';

/**
 * Circuit breakers.
 *
 * Per-account AUTH breaker: 3 consecutive auth failures → open 15 min.
 * Global STRUCTURAL breaker: trips on any of
 *   - canary fails twice consecutively
 *   - ≥5 consecutive structural failures across ≥2 branches
 *   - structural rate > 25% over last 20 jobs
 *   - identical normalised turboly_error on ≥5 records across ≥2 branches in 10 min
 * WHILE OPEN, jobs stay QUEUED — never DLQ'd. The poller stops enqueuing.
 */
export class AuthBreaker {
  private consecutive = new Map<string, number>();
  private openUntil = new Map<string, number>();

  isOpen(branchCode: string): boolean {
    return (this.openUntil.get(branchCode) ?? 0) > Date.now();
  }
  recordSuccess(branchCode: string): void {
    this.consecutive.set(branchCode, 0);
  }
  async recordFailure(branchCode: string): Promise<void> {
    const n = (this.consecutive.get(branchCode) ?? 0) + 1;
    this.consecutive.set(branchCode, n);
    if (n >= 3) {
      this.openUntil.set(branchCode, Date.now() + 15 * 60_000);
      this.consecutive.set(branchCode, 0);
      await fireAlert({ level: 'page', code: 'AUTH_BREAKER_OPEN', branchCode, message: '3 auth failures — 15 min open' });
    }
  }
}

interface RecentFailure {
  at: number;
  branchCode: string;
  errorText: string;
}

export class StructuralBreaker {
  private open = false;
  private openedAt = 0;
  private consecutiveStructural: RecentFailure[] = [];
  private recent: RecentFailure[] = [];
  private last20: boolean[] = []; // true = structural failure
  private canaryConsecutiveFail = 0;

  isOpen(): boolean {
    return this.open;
  }

  private async trip(reason: string): Promise<void> {
    if (this.open) return;
    this.open = true;
    this.openedAt = Date.now();
    await fireAlert({ level: 'page', code: 'STRUCTURAL_BREAKER_OPEN', message: reason });
  }

  /** Only a human (via canary-green + explicit resume) closes it — see degradation. */
  async reset(reason: string): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.canaryConsecutiveFail = 0;
    this.consecutiveStructural = [];
    await fireAlert({ level: 'ops', code: 'STRUCTURAL_BREAKER_CLOSED', message: reason });
  }

  recordJobOutcome(structural: boolean): void {
    this.last20.push(structural);
    if (this.last20.length > 20) this.last20.shift();
  }

  async recordStructuralFailure(branchCode: string, errorText: string): Promise<void> {
    const f: RecentFailure = { at: Date.now(), branchCode, errorText: normalizeErr(errorText) };
    this.consecutiveStructural.push(f);
    this.recent.push(f);
    this.recordJobOutcome(true);
    this.gc();

    // ≥5 consecutive structural across ≥2 branches
    if (this.consecutiveStructural.length >= 5 && new Set(this.consecutiveStructural.map((x) => x.branchCode)).size >= 2) {
      await this.trip('≥5 consecutive structural failures across ≥2 branches');
    }
    // structural rate > 25% over last 20
    const rate = this.last20.filter(Boolean).length / Math.max(1, this.last20.length);
    if (this.last20.length >= 20 && rate > 0.25) {
      await this.trip(`structural rate ${(rate * 100).toFixed(0)}% over last 20`);
    }
    // identical error on ≥5 records / ≥2 branches / 10 min  → schema change, not data
    const sameErr = this.recent.filter((x) => x.errorText === f.errorText && Date.now() - x.at < 10 * 60_000);
    if (sameErr.length >= 5 && new Set(sameErr.map((x) => x.branchCode)).size >= 2) {
      await this.trip(`identical error on ${sameErr.length} records across branches: "${f.errorText}"`);
    }
  }

  recordNonStructuralOutcome(): void {
    this.consecutiveStructural = [];
    this.recordJobOutcome(false);
  }

  async recordCanary(ok: boolean): Promise<void> {
    if (ok) {
      this.canaryConsecutiveFail = 0;
      return;
    }
    this.canaryConsecutiveFail++;
    if (this.canaryConsecutiveFail >= 2) await this.trip('canary failed twice consecutively');
  }

  private gc(): void {
    const cutoff = Date.now() - 15 * 60_000;
    this.recent = this.recent.filter((x) => x.at > cutoff);
    if (this.consecutiveStructural.length > 50) this.consecutiveStructural = this.consecutiveStructural.slice(-50);
  }
}

/** Collapse volatile bits (ids, numbers, timestamps) so "same error" comparison works. */
export function normalizeErr(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/spk:[0-9a-hjkmnp-tv-z]{26}/gi, 'spk:#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
