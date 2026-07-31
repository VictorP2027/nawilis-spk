import {
  buildSpkDoc, resolveSkus, validateLayer1, correlationToken,
  type SpkIntakeInputT, type Finding, type SpkDoc,
} from '@spk/core';
import {
  insertSpk, getByUploadId, getSpk, transition, emit, upsertVehicle,
  findVehicleByVariants, loadMirror, nextQueueNumber,
} from './store.js';

export interface IngestResult {
  spkId: string;
  state: SpkDoc['state'];
  correlationToken: string;
  findings: Finding[];
  needsReview: boolean;
  blocked: boolean;
  duplicate?: boolean;
}

/**
 * Capture pipeline (Supabase). Same rules as the Mongo version:
 * build → resolve SKUs → Layer-1 (data sanity ONLY) → save → park in
 * awaiting_assignment. Turboly business rules are push-time, never blocking capture.
 */
export async function ingestSpk(input: SpkIntakeInputT): Promise<IngestResult> {
  const existing = await getByUploadId(input.uploadId);
  if (existing) {
    return { spkId: existing._id, state: existing.state, correlationToken: existing.push.correlationToken, findings: [], needsReview: existing.state === 'needs_review', blocked: false, duplicate: true };
  }

  let doc = buildSpkDoc(input);
  doc.uploadId = input.uploadId;
  if (input.raw) doc.rawForm = input.raw;
  doc.nomorAntrian = await nextQueueNumber(doc.branchCode, doc.capture.businessDate);
  if (input.serviceAdvisorName) doc.signatures.menerima.namaJelas = input.serviceAdvisorName;

  const mirror = await loadMirror(doc.branchCode);
  doc = resolveSkus(doc, mirror.skuFor);

  const prior = await findVehicleByVariants(doc.vehicle.plateVariants);
  const l1 = validateLayer1(doc, prior);

  try {
    await insertSpk(doc);
  } catch {
    const winner = await getByUploadId(input.uploadId);
    if (winner) return { spkId: winner._id, state: winner.state, correlationToken: winner.push.correlationToken, findings: [], needsReview: winner.state === 'needs_review', blocked: false, duplicate: true };
    throw new Error('insert failed');
  }
  await emit({ spkId: doc._id, type: 'captured', by: input.operatorUserId, data: { mode: input.captureMode, branch: input.branchCode } });
  await upsertVehicle(doc);

  await transition(doc._id, 'captured', 'extracted');
  await transition(doc._id, 'extracted', 'needs_review');

  if (l1.blocked) {
    return { spkId: doc._id, state: 'needs_review', correlationToken: doc.push.correlationToken, findings: l1.findings, needsReview: true, blocked: true };
  }
  if (input.captureMode === 'photo' && l1.needsConfirm) {
    return { spkId: doc._id, state: 'needs_review', correlationToken: doc.push.correlationToken, findings: l1.findings, needsReview: true, blocked: false };
  }
  await transition(doc._id, 'needs_review', 'validated');
  const parked = await transition(doc._id, 'validated', 'awaiting_assignment');
  return { spkId: doc._id, state: parked?.state ?? 'validated', correlationToken: doc.push.correlationToken, findings: l1.findings, needsReview: false, blocked: false };
}

export async function confirmReview(spkId: string, by: string): Promise<SpkDoc | null> {
  await transition(spkId, 'needs_review', 'validated');
  const parked = await transition(spkId, 'validated', 'awaiting_assignment');
  if (parked) await emit({ spkId, type: 'review_confirmed', by });
  return parked;
}

/** Assignment gate — releases a parked SPK to the push queue (given to a mechanic). */
export async function assignMechanic(
  spkId: string,
  args: { mechanicCode: string; by: string; via: 'ticket_scan' | 'console'; lineNos?: number[]; waktuMinutes?: number },
): Promise<SpkDoc | null> {
  const now = new Date().toISOString();
  const doc = await getSpk(spkId);
  if (!doc) return null;
  if (doc.assignment && doc.state !== 'awaiting_assignment') return doc;

  const targets = args.lineNos && args.lineNos.length ? new Set(args.lineNos) : null;
  const jobLines = doc.jobLines.map((l) =>
    !targets || targets.has(l.lineNo)
      ? { ...l, mk: { mechanicCode: args.mechanicCode, source: 'ticket_scan' as const }, waktu: args.waktuMinutes != null ? { minutes: args.waktuMinutes, source: 'ticket_scan' as const } : l.waktu }
      : l,
  );
  const updated = await transition(spkId, 'awaiting_assignment', 'queued', {
    jobLines,
    assignment: { assignedAt: now, assignedBy: args.by, primaryMechanicCode: args.mechanicCode, via: args.via },
    push: { ...doc.push, nextAttemptAt: now, attempt: 0 },
  });
  if (updated) await emit({ spkId, type: 'assigned_to_mechanic', by: args.by, data: { mechanicCode: args.mechanicCode, via: args.via } });
  return updated;
}

export async function voidBeforeAssignment(spkId: string, by: string, reason: string): Promise<SpkDoc | null> {
  const updated = await transition(spkId, 'awaiting_assignment', 'voided', {});
  if (updated) await emit({ spkId, type: 'voided_declined', by, data: { reason } });
  return updated;
}

export { correlationToken };
