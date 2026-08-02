import { collections } from './mongo.js';
import { canTransition, IllegalTransitionError } from './states.js';
import { newSpkId, correlationToken, vehicleRef } from './ids.js';
import { parsePlate, plateVariants, parseKm, parseWa, normalizeBrand, jakartaBusinessDate } from './indonesia.js';
import { CAR_BRANDS, REF_BRANCHES } from './refdata.js';
import type { SpkDoc, PipelineState, SpkEvent, JobLine, ConditionCheck, FieldMetaEntry, BranchType } from './types.js';
import type { SpkIntakeInputT } from './schema.js';

const SCHEMA_VERSION = 1;

/**
 * Compare-and-swap state transition. This is THE concurrency-safety primitive:
 * the filter pins the expected current state, so two workers can never both
 * advance the same document. Returns the updated doc, or null if the CAS lost
 * (someone else moved it first). Throws on an illegal transition attempt.
 */
export async function transition(
  spkId: string,
  from: PipelineState,
  to: PipelineState,
  set: Partial<SpkDoc> = {},
  extraFilter: Record<string, unknown> = {},
): Promise<SpkDoc | null> {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  const now = new Date().toISOString();
  const res = await collections.spk().findOneAndUpdate(
    { _id: spkId, state: from, ...extraFilter },
    { $set: { ...set, state: to, updatedAt: now } },
    { returnDocument: 'after' },
  );
  return res ?? null;
}

/**
 * Assign the job to a mechanic. THIS is the gate the whole "only push used
 * Service Orders" rule hangs on: it moves the record from `awaiting_assignment`
 * (parked in Mongo, never pushed) to `queued` (eligible for the Turboly push
 * poller), writes the mechanic onto the relevant job lines, and stamps
 * nextAttemptAt=now so the poller picks it up immediately.
 *
 * Triggered by the mechanic scanning the printed QR ticket at job start, or by
 * the ops console. Idempotent: a re-scan of an already-assigned SPK is a no-op.
 *
 * Returns the updated doc, or null if the record wasn't awaiting assignment
 * (already assigned, declined, or not yet validated).
 */
export async function assignMechanic(
  spkId: string,
  args: { mechanicCode: string; by: string; via: 'ticket_scan' | 'console'; lineNos?: number[]; waktuMinutes?: number },
): Promise<SpkDoc | null> {
  const now = new Date().toISOString();
  const doc = await collections.spk().findOne({ _id: spkId });
  if (!doc) return null;

  // Idempotency: if it's already been released, don't double-assign or re-queue.
  if (doc.assignment && doc.state !== 'awaiting_assignment') return doc;

  const targetLines = args.lineNos && args.lineNos.length ? new Set(args.lineNos) : null;
  const jobLines = doc.jobLines.map((l) =>
    !targetLines || targetLines.has(l.lineNo)
      ? {
          ...l,
          mk: { mechanicCode: args.mechanicCode, source: 'ticket_scan' as const },
          waktu: args.waktuMinutes != null ? { minutes: args.waktuMinutes, source: 'ticket_scan' as const } : l.waktu,
        }
      : l,
  );

  const updated = await transition(spkId, 'awaiting_assignment', 'queued', {
    jobLines,
    assignment: { assignedAt: now, assignedBy: args.by, primaryMechanicCode: args.mechanicCode, via: args.via },
    push: { ...doc.push, nextAttemptAt: now, attempt: 0 },
  });
  if (updated) {
    await emit({ spkId, type: 'assigned_to_mechanic', by: args.by, data: { mechanicCode: args.mechanicCode, via: args.via } });
  }
  return updated;
}

/** Customer declined the work before assignment — terminal, never pushed. */
export async function voidBeforeAssignment(spkId: string, by: string, reason: string): Promise<SpkDoc | null> {
  const updated = await transition(spkId, 'awaiting_assignment', 'voided', {});
  if (updated) await emit({ spkId, type: 'voided_declined', by, data: { reason } });
  return updated;
}

export async function emit(evt: Omit<SpkEvent, '_id' | 'at'> & { at?: string }): Promise<void> {
  await collections.spkEvents().insertOne({
    _id: newSpkId(),
    at: evt.at ?? new Date().toISOString(),
    spkId: evt.spkId,
    type: evt.type,
    by: evt.by,
    data: evt.data,
  });
}

/**
 * Build a fresh SpkDoc from validated intake input. Applies all Indonesian
 * normalisation and records provenance (fieldMeta) for every field so the
 * review/validation layers can reason about it.
 */
export function buildSpkDoc(input: SpkIntakeInputT, opts: { correlationSalt?: string } = {}): SpkDoc {
  void opts;
  const _id = newSpkId();
  const now = new Date().toISOString();
  const arrival = input.arrivalTime ?? input.capturedAt;
  const captureLagMinutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(arrival)) / 60000));

  const plate = parsePlate(input.vehicle.noPolisi);
  const km = parseKm(input.vehicle.km);
  const wa = input.customer.wa ? parseWa(input.customer.wa) : { e164: null };
  const brand = input.vehicle.merk ? normalizeBrand(input.vehicle.merk, CAR_BRANDS) : { normalized: null, score: 0, raw: '' };

  const branch = REF_BRANCHES.find((b) => b.code === input.branchCode);
  const branchType: BranchType = branch?.type ?? 'NAWILIS';

  const fieldMeta: FieldMetaEntry[] = [];
  const meta = (path: string, source: FieldMetaEntry['source'], validator: FieldMetaEntry['validator'] = 'pass', tier: FieldMetaEntry['tier'] = 'AUTO_PASS') =>
    fieldMeta.push({ path, source, modelConfidence: null, validator, tier, corrections: 0 });

  const src = input.captureMode === 'typed' ? 'typed' : 'photo_extract';
  meta('vehicle.noPolisi', src, plate.ok ? 'pass' : 'fail', plate.correctionsApplied.length ? 'CONFIRM' : 'AUTO_PASS');
  meta('vehicle.km', src, km.value != null ? 'pass' : 'fail');
  meta('customer.nama', src);
  if (input.customer.wa) meta('customer.waE164', src, wa.e164 ? 'pass' : 'warn', wa.e164 ? 'AUTO_PASS' : 'CONFIRM');

  const jobLines: JobLine[] = input.jobLines.map((l, i) => ({
    lineNo: i + 1,
    serviceCode: l.serviceCode,
    ordered: l.ordered,
    qty: l.qty,
    keterangan: l.keterangan,
    mk: { mechanicCode: null, source: 'pending_ticket_scan' as const },
    waktu: { minutes: null, source: 'pending_ticket_scan' as const },
    quotedPrice: l.quotedPrice,
    // Operator-chosen variant wins; else resolveSkus fills the branch default.
    turbolySku: l.chosenSku ?? null,
  }));

  const conditionChecks: ConditionCheck[] = input.conditionChecks.map((c, i) => ({
    rowNo: i + 1,
    item: c.item,
    marks: c.marks,
    status: c.marks.length === 0 ? 'UNMARKED' : c.marks.some((m) => m.toUpperCase() === 'OK') ? 'OK' : 'ISSUE',
    source: input.captureMode === 'typed' ? 'typed' : 'photo_extract',
  }));

  const orderedCount = jobLines.filter((l) => l.ordered).length;
  const quotedTotal = jobLines.reduce((s, l) => s + (l.ordered ? (l.quotedPrice ?? 0) * l.qty : 0), 0);

  return {
    _id,
    schemaVersion: SCHEMA_VERSION,
    docType: input.docType,
    tenantId: 'NAWILIS',
    branchCode: input.branchCode,
    branchType,
    deviceBindingVerified: input.deviceBindingVerified,
    spkNumber: { normalized: input.spkNumber, source: src },
    qr: { payload: input.qrPayload, kind: 'unknown' },
    capture: {
      mode: input.captureMode,
      operator: { userId: input.operatorUserId, pin: input.operatorPinVerified ? 'verified' : 'skipped' },
      arrivalTime: arrival,
      capturedAt: input.capturedAt,
      receivedAt: now,
      captureLagMinutes,
      businessDate: jakartaBusinessDate(now),
    },
    customer: {
      nama: input.customer.nama,
      waE164: wa.e164 ?? null,
      alamat: input.customer.alamat,
      kontakLain: input.customer.kontakLain,
      turbolyCustomerId: input.customer.turbolyCustomerId,
      consent: { marketing: false, at: null },
    },
    vehicle: {
      noPolisi: { full: plate.full, display: plate.display, correctionsApplied: plate.correctionsApplied },
      plateVariants: plateVariants(plate.full),
      merkNormalized: brand.normalized,
      merkRaw: input.vehicle.merk,
      merkMatchScore: brand.score,
      tipeNormalized: input.vehicle.tipe,
      tahun: input.vehicle.tahun,
      warna: input.vehicle.warna,
      createMakeConfirmed: input.vehicle.createMakeConfirmed ?? false,
      km: { raw: km.raw, value: km.value ?? 0 },
      vehicleRef: plate.ok ? vehicleRef(plate.full) : null,
      bindReason: null,
    },
    complaint: { keluhan: input.complaint },
    jobLines,
    jobLineSummary: { orderedCount, unmappedCount: orderedCount, quotedTotal },
    conditionChecks,
    damageDiagram: { imageRef: input.attachments.find((a) => a.kind === 'damage')?.ref ?? null, neverReviewed: true },
    signatures: {
      menyerahkan: {
        present: input.signatures.menyerahkanPresent,
        inkDensity: input.signatures.menyerahkanInkDensity ?? undefined,
        computedAt: 'device',
      },
      menerima: { present: input.signatures.menerimaPresent, namaJelas: input.signatures.menerimaNamaJelas },
    },
    authorization: { accepted: input.signatures.menyerahkanPresent, acceptedBasis: 'wet_signature', textVersion: 'SPK_AUTH_2024' },
    rekomendasiService: { text: input.rekomendasiService },
    estimasi: { minutes: input.estimasiMinutes },
    fieldMeta,
    lifecycle: 'open',
    amendments: [],
    assignment: null,
    scheduledAt: input.scheduledAt ?? null,
    state: 'captured',
    push: {
      correlationToken: correlationToken(_id),
      priority: branchType === 'QUICKSERV' ? 95 : 50,
      attempt: 0,
      maxAttempts: 6,
      nextAttemptAt: null,
      lease: { workerId: null, epoch: 0, expiresAt: null },
      claimedAt: null,
      phases: { order: { status: 'pending' }, workOrder: { status: 'pending' } },
      storeSwitch: { expected: branch?.turbolyStoreNameGuess ?? input.branchCode, observed: null, verifiedFrom: 'document_detail' },
      failureClass: null,
      lastError: null,
    },
    turboly: { serviceOrderNo: null, workOrderNo: null, readback: { matchedOn: [], lineCount: null, lineSkus: [], km: null } },
    createdAt: now,
    updatedAt: now,
  };
}
