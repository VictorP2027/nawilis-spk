/**
 * Failure classification for outbound work. The two classes are the whole
 * retry policy: a caller retries a TransientError and routes a DataError to a
 * human, so anything that throws must decide which it is at the throw site —
 * the caller has no status code left to inspect.
 *
 * turboly/rpaSink.ts declares the same two names for the Turboly push. They are
 * NOT imported from there because that module pulls Playwright in, and this one
 * is reachable from the web app's bundle (see the note in index.ts). Same
 * convention, separate identity: catch these with the classes from '@spk/core'
 * and the Turboly ones with the classes from '@spk/core/turboly'.
 */

/** A data-quality failure (unreachable number, rejected template) — retrying won't help. */
export class DataError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DataError';
  }
}

/** A slow/flaky remote (5xx, timeout, gateway down) — the same input may succeed later. */
export class TransientError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransientError';
  }
}
