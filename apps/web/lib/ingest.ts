import {
  buildSpkDoc, loadMirror, resolveSkus, validateLayer1,
  transition, emit, collections, vehicleRef,
  type SpkIntakeInputT, type Finding, type SpkDoc, type VehicleDoc,
} from '@spk/core';
import { db } from './db';

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
 * The full server-side ingest pipeline for one SPK:
 *   build → resolve SKUs → Layer 1 → insert (idempotent on uploadId) →
 *   extracted → needs_review → Layer 2 → (validated → awaiting_assignment | stay for review)
 *
 * Note: the record STOPS at `awaiting_assignment`. It is NOT queued for Turboly
 * until a mechanic is assigned (assignMechanic), per the "only push used
 * Service Orders" rule.
 */
export async function ingestSpk(input: SpkIntakeInputT): Promise<IngestResult> {
  await db();

  // Idempotency: a retried upload returns the existing record.
  const existing = await collections.spk().findOne({ uploadId: input.uploadId });
  if (existing) {
    return {
      spkId: existing._id,
      state: existing.state,
      correlationToken: existing.push.correlationToken,
      findings: [],
      needsReview: existing.state === 'needs_review',
      blocked: false,
      duplicate: true,
    };
  }

  let doc = buildSpkDoc(input);
  doc.uploadId = input.uploadId;
  // Save the complete raw form verbatim (nothing entered is ever lost).
  if (input.raw) doc.rawForm = input.raw;
  // Daily per-outlet queue number: YYYYMMDD + 3-digit sequence (e.g. 20260401001).
  doc.nomorAntrian = await nextQueueNumber(doc.branchCode, doc.capture.businessDate);
  // The "Yang menerima" staffer / advisor is captured on the SPK; the push
  // resolves advisor + salesperson from this name against the Turboly mirror.
  if (input.serviceAdvisorName) doc.signatures.menerima.namaJelas = input.serviceAdvisorName;

  const mirror = await loadMirror(doc.branchCode);
  doc = resolveSkus(doc, mirror.skuFor);

  // Vehicle history for KM monotonicity + prefill.
  const prior = await findVehicle(doc);
  const l1 = validateLayer1(doc, prior);

  // Persist as captured. The unique uploadId index guards against races.
  try {
    await collections.spk().insertOne(doc);
  } catch (e) {
    // Duplicate uploadId (race) — return the winner.
    const winner = await collections.spk().findOne({ uploadId: input.uploadId });
    if (winner) return { spkId: winner._id, state: winner.state, correlationToken: winner.push.correlationToken, findings: [], needsReview: winner.state === 'needs_review', blocked: false, duplicate: true };
    throw e;
  }
  await emit({ spkId: doc._id, type: 'captured', by: input.operatorUserId, data: { mode: input.captureMode, branch: input.branchCode } });
  await upsertVehicle(doc);

  // captured → extracted → needs_review (every doc passes through the gate)
  await transition(doc._id, 'captured', 'extracted');
  await transition(doc._id, 'extracted', 'needs_review');

  // INTAKE validates DATA SANITY ONLY (Layer 1). Turboly business rules
  // (does the advisor/SKU/store exist, is there a signature for invoicing) are
  // PUSH-time concerns — they must never stop data being captured into MongoDB.
  // They run later, when the job is assigned + pushed (see the worker + push route).
  const findings = l1.findings;

  if (l1.blocked) {
    // Truly unusable data (bad plate / no job line / no customer / unparseable KM).
    // Still SAVED in Mongo (as needs_review) — the operator fixes it in the console.
    return { spkId: doc._id, state: 'needs_review', correlationToken: doc.push.correlationToken, findings, needsReview: true, blocked: true };
  }

  // Photo mode with low-confidence fields → hold for a human to eyeball the scan.
  // Typed mode always parks straight through (nothing to re-read).
  if (input.captureMode === 'photo' && l1.needsConfirm) {
    return { spkId: doc._id, state: 'needs_review', correlationToken: doc.push.correlationToken, findings, needsReview: true, blocked: false };
  }

  // Saved → parked in awaiting_assignment (NOT queued to Turboly until a mechanic
  // is assigned). Any Layer-1 CONFIRM/WARN findings ride along as informational notes.
  await transition(doc._id, 'needs_review', 'validated');
  const parked = await transition(doc._id, 'validated', 'awaiting_assignment');
  return {
    spkId: doc._id,
    state: parked?.state ?? 'validated',
    correlationToken: doc.push.correlationToken,
    findings,
    needsReview: false,
    blocked: false,
  };
}

/**
 * Confirm a reviewed SPK (operator resolved the CONFIRM flags): advance
 * needs_review → validated → awaiting_assignment.
 */
export async function confirmReview(spkId: string, by: string): Promise<SpkDoc | null> {
  await db();
  await transition(spkId, 'needs_review', 'validated');
  const parked = await transition(spkId, 'validated', 'awaiting_assignment');
  if (parked) await emit({ spkId, type: 'review_confirmed', by });
  return parked;
}

/** Daily per-outlet queue number, e.g. "20260401" + zero-padded sequence. */
async function nextQueueNumber(branchCode: string, businessDate: string): Promise<string> {
  const ymd = businessDate.replace(/-/g, '');
  const countToday = await collections.spk().countDocuments({ branchCode, 'capture.businessDate': businessDate });
  return `${ymd}${String(countToday + 1).padStart(3, '0')}`;
}

async function findVehicle(doc: SpkDoc): Promise<VehicleDoc | null> {
  if (!doc.vehicle.plateVariants.length) return null;
  return collections.vehicles().findOne({ plateVariants: { $in: doc.vehicle.plateVariants } });
}

async function upsertVehicle(doc: SpkDoc): Promise<void> {
  if (!doc.vehicle.noPolisi.full) return;
  const _id = vehicleRef(doc.vehicle.noPolisi.full);
  await collections.vehicles().updateOne(
    { _id },
    {
      $set: {
        plateFull: doc.vehicle.noPolisi.full,
        merk: doc.vehicle.merkNormalized,
        tipe: doc.vehicle.tipeNormalized,
        tahun: doc.vehicle.tahun,
        warna: doc.vehicle.warna,
        lastKm: doc.vehicle.km.value,
        lastSeenAt: doc.capture.receivedAt,
        lastBranch: doc.branchCode,
      },
      $addToSet: { plateVariants: { $each: doc.vehicle.plateVariants } },
      $inc: { visitCount: 1 },
      $setOnInsert: { _id, customerRefs: [] },
    },
    { upsert: true },
  );
}
