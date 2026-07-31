import { ulid } from 'ulid';

/** New SPK primary key. Time-ordered, collision-resistant. */
export function newSpkId(): string {
  return ulid();
}

/**
 * The correlation token written into Turboly's REFERENCE NUMBER field and used
 * as the sole identity for read-back and reconciliation.
 * Format: `SPK:<ulid>` — greppable, and stable across retries.
 */
export function correlationToken(spkId: string): string {
  return `SPK:${spkId}`;
}

export function parseCorrelationToken(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /SPK:([0-9A-HJKMNP-TV-Z]{26})/i.exec(ref);
  return m?.[1] ?? null;
}

/** Stable per-vehicle reference from a canonical plate. */
export function vehicleRef(plateFull: string): string {
  return `veh_${plateFull.toUpperCase()}`;
}

/** Claim-table id — makes double-push structurally hard. */
export function claimId(spkId: string, phase: 'order' | 'workOrder'): string {
  return `${spkId}#${phase}`;
}
