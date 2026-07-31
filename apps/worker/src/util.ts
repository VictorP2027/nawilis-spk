/** Minimal async mutex — serialises access to a single-session-per-branch. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class MutexRegistry {
  private map = new Map<string, Mutex>();
  get(key: string): Mutex {
    let m = this.map.get(key);
    if (!m) {
      m = new Mutex();
      this.map.set(key, m);
    }
    return m;
  }
}

/** Exponential backoff with full jitter (deterministic jitter would break tests less, but full jitter is correct here). */
export function backoffMs(attempt: number, baseMs = 30_000, capMs = 3_600_000, rand = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rand() * exp);
}
