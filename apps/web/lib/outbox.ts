'use client';

/**
 * Offline-first outbox. Intake NEVER blocks on the network: a submit is written
 * to the outbox and flushed opportunistically. Uses localStorage for simplicity
 * (swap for IndexedDB when payloads include images). `navigator.onLine` is not
 * trusted — flush attempts are the real connectivity probe.
 */
const KEY = 'spk-outbox-v1';

export interface OutboxItem {
  uploadId: string;
  payload: unknown;
  createdAt: number;
  lastError?: string;
}

function read(): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}
function write(items: OutboxItem[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function enqueue(item: OutboxItem): void {
  const items = read();
  if (!items.some((i) => i.uploadId === item.uploadId)) {
    items.push(item);
    write(items);
  }
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
      if (res.status === 400 || res.status === 422) {
        // Bad payload — don't retry forever; keep with error for the console.
        remaining.push({ ...item, lastError: `HTTP ${res.status}` });
      } else {
        remaining.push({ ...item, lastError: `HTTP ${res.status}` });
      }
    } catch (e) {
      remaining.push({ ...item, lastError: (e as Error).message });
    }
  }
  write(remaining);
  return sent;
}

/** Submit now (online) or park in the outbox (offline). Returns server result or null if parked. */
export async function submitOrQueue(uploadId: string, payload: unknown): Promise<Response | null> {
  try {
    const res = await fetch('/api/spk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch {
    enqueue({ uploadId, payload, createdAt: Date.now() });
    return null;
  }
}
