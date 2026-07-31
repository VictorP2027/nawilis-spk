import { connect } from '@spk/core';

let ready: Promise<unknown> | null = null;

/** Idempotent connect for Next.js server runtime (route handlers / RSC). */
export function db(): Promise<unknown> {
  if (!ready) ready = connect(process.env.MONGODB_URI, process.env.MONGODB_DB);
  return ready;
}
