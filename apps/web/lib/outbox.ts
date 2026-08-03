'use client';

/**
 * Offline-first outbox. Intake NEVER blocks on the network: a submit is written
 * to the outbox and flushed opportunistically. Uses localStorage for simplicity
 * (payloads may now carry signature images, so every write is quota-guarded:
 * on overflow the bulky images are stripped from queued items — the SPK data
 * itself is never sacrificed for a signature). `navigator.onLine` is not
 * trusted — flush attempts are the real connectivity probe.
 */
const KEY = 'spk-outbox-v1';

/** Poison items (HTTP 400/422) are kept for the console, but not forever. */
const POISON_MAX_AGE_MS = 7 * 24 * 3600_000;

export interface OutboxItem {
  uploadId: string;
  payload: unknown;
  createdAt: number;
  lastError?: string;
}

export type QueueResult = 'queued' | 'queued_no_images' | 'lost';

function read(): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function tryWrite(items: OutboxItem[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false; // QuotaExceededError etc. — caller decides the fallback
  }
}

/** Drop the bulky signature data URLs from a payload (quota fallback). */
function stripImages(payload: unknown): unknown {
  const p = payload as { signatures?: Record<string, unknown> } | null;
  if (!p || typeof p !== 'object' || !p.signatures) return payload;
  return { ...p, signatures: { ...p.signatures, menyerahkanImage: null, menerimaImage: null } };
}

/** Quota-safe write: full → images stripped from ALL queued items → give up. */
function writeSafe(items: OutboxItem[]): 'ok' | 'ok_no_images' | 'fail' {
  if (tryWrite(items)) return 'ok';
  const slim = items.map((i) => ({ ...i, payload: stripImages(i.payload) }));
  if (tryWrite(slim)) return 'ok_no_images';
  return 'fail'; // localStorage untouched (setItem is atomic)
}

export function enqueue(item: OutboxItem): QueueResult {
  const items = read().filter(
    (i) => !(i.lastError && /HTTP 4(00|22)/.test(i.lastError) && Date.now() - i.createdAt > POISON_MAX_AGE_MS),
  );
  if (!items.some((i) => i.uploadId === item.uploadId)) items.push(item);
  const w = writeSafe(items);
  if (w === 'ok') return 'queued';
  if (w === 'ok_no_images') return 'queued_no_images';
  return 'lost';
}

export function pending(): number {
  return read().length;
}

/** Try to flush the outbox. Returns the number successfully sent. */
export async function flush(): Promise<number> {
  const items = read();
  let sent = 0;
  const remaining: OutboxItem[] = [];
  for (const item of items) {
    try {
      const res = await fetch('/api/spk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      if (res.ok) {
        sent++;
        continue; // drop from outbox
      }
      // Bad payload (400/422) — keep with error for the console; aged out by enqueue.
      remaining.push({ ...item, lastError: `HTTP ${res.status}` });
    } catch (e) {
      remaining.push({ ...item, lastError: (e as Error).message });
    }
  }
  writeSafe(remaining);
  return sent;
}

/**
 * Submit now (online) or park in the outbox (offline).
 * Returns the server Response, or a QueueResult when parked:
 * 'queued' (safe), 'queued_no_images' (saved, signature images dropped for
 * space), 'lost' (storage full — the caller MUST tell the operator).
 */
export async function submitOrQueue(uploadId: string, payload: unknown): Promise<Response | QueueResult> {
  try {
    const res = await fetch('/api/spk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch {
    return enqueue({ uploadId, payload, createdAt: Date.now() });
  }
}
