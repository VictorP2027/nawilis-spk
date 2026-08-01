import type { SpkDoc, TbServiceProduct, TbStore, TbMechanic, VehicleDoc } from './types.js';
import { parseKm, parseWa } from './indonesia.js';

/**
 * Three-layer validation.
 *   Layer 1 — form-level, deterministic, runs on device AND server.
 *   Layer 2 — pre-push business rules, needs the Turboly mirror.
 *   Layer 3 — post-push reconciliation (see turboly/verify.ts + worker/reconciler.ts).
 *
 * Severity:
 *   BLOCK   — cannot proceed (submission / enqueue is refused).
 *   CONFIRM — requires an explicit human tap during review.
 *   WARN    — surfaced, does not stop anything.
 */
export type Severity = 'BLOCK' | 'CONFIRM' | 'WARN';

export interface Finding {
  rule: string;
  severity: Severity;
  path: string;
  message: string; // Bahasa-facing where it reaches staff
  detail?: string;
}

export interface ValidationResult {
  findings: Finding[];
  blocked: boolean;
  needsConfirm: boolean;
}

function summarize(findings: Finding[]): ValidationResult {
  return {
    findings,
    blocked: findings.some((f) => f.severity === 'BLOCK'),
    needsConfirm: findings.some((f) => f.severity === 'CONFIRM'),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 — form-level (client + server)
// ─────────────────────────────────────────────────────────────────────────

export function validateLayer1(doc: SpkDoc, prior?: VehicleDoc | null): ValidationResult {
  const f: Finding[] = [];

  // Plate
  if (!doc.vehicle.noPolisi.full || !/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(doc.vehicle.noPolisi.full)) {
    f.push({
      rule: 'PLATE_FORMAT',
      severity: 'CONFIRM', // warn-only by user directive: never refuse input
      path: 'vehicle.noPolisi',
      message: 'Format No. Polisi tidak valid (contoh: B 1234 XYZ — huruf wilayah, angka, huruf).',
    });
  }
  if (doc.vehicle.noPolisi.correctionsApplied.length > 0) {
    // A corrected plate can never auto-pass, even if it matches history.
    f.push({
      rule: 'PLATE_CORRECTION_CAP',
      severity: 'CONFIRM',
      path: 'vehicle.noPolisi',
      message: 'No. Polisi dikoreksi otomatis — mohon periksa.',
      detail: doc.vehicle.noPolisi.correctionsApplied.join(', '),
    });
  }

  // KM — separator + range + monotonicity
  const km = doc.vehicle.km.value;
  if (km === null || Number.isNaN(km)) {
    f.push({ rule: 'KM_PARSE', severity: 'CONFIRM', path: 'vehicle.km', message: 'KM tidak terbaca.' });
  } else {
    if (km < 0) {
      f.push({ rule: 'KM_RANGE', severity: 'CONFIRM', path: 'vehicle.km', message: 'KM tidak boleh negatif.' });
    } else if (km > 2_000_000) {
      // Implausible, but never block CAPTURE on it — just ask to double-check.
      f.push({ rule: 'KM_RANGE', severity: 'CONFIRM', path: 'vehicle.km', message: 'KM sangat tinggi — mohon periksa.' });
    }
    if (prior?.lastKm != null) {
      if (km < prior.lastKm) {
        // CONFIRM, not BLOCK — one bad first read must not brick a vehicle forever.
        f.push({
          rule: 'KM_MONOTONIC',
          severity: 'CONFIRM',
          path: 'vehicle.km',
          message: `KM lebih kecil dari kunjungan sebelumnya (${prior.lastKm.toLocaleString('id-ID')}).`,
          detail: 'Pilih: koreksi bacaan ini, atau koreksi riwayat tersimpan.',
        });
      }
    } else {
      // First-visit vehicle: KM is the only field with permanent downstream memory
      // and no cross-check → always CONFIRM.
      f.push({
        rule: 'KM_FIRST_VISIT',
        severity: 'CONFIRM',
        path: 'vehicle.km',
        message: 'Kendaraan baru — konfirmasi bacaan KM awal.',
      });
    }
  }

  // WA
  if (doc.customer.waE164) {
    const wa = parseWa(doc.customer.waE164);
    if (!wa.ok) {
      f.push({ rule: 'WA_FORMAT', severity: 'CONFIRM', path: 'customer.waE164', message: 'Nomor WA tidak valid.' });
    } else if (!wa.operatorKnown) {
      f.push({ rule: 'WA_OPERATOR', severity: 'WARN', path: 'customer.waE164', message: 'Prefix operator tidak dikenal — mohon periksa.' });
    }
  }

  // Brand / model / year sanity (WARN only — the vocab always lags the market)
  if (doc.vehicle.merkRaw && doc.vehicle.merkNormalized === null) {
    f.push({
      rule: 'MERK_UNKNOWN',
      severity: 'WARN',
      path: 'vehicle.merkNormalized',
      message: `Merk "${doc.vehicle.merkRaw}" tidak dikenali.`,
      detail: `score=${doc.vehicle.merkMatchScore}`,
    });
  }
  if (doc.vehicle.tahun != null && (doc.vehicle.tahun < 1950 || doc.vehicle.tahun > new Date().getUTCFullYear() + 1)) {
    f.push({ rule: 'TAHUN_RANGE', severity: 'WARN', path: 'vehicle.tahun', message: 'Tahun kendaraan tidak wajar.' });
  }

  // At least one ordered job line
  if (!doc.jobLines.some((l) => l.ordered)) {
    f.push({ rule: 'JOBLINE_MIN_ONE', severity: 'CONFIRM', path: 'jobLines', message: 'Minimal satu pekerjaan harus dipilih.' });
  }

  // Customer name required (Turboly CUSTOMER is required)
  if (!doc.customer.nama || doc.customer.nama.trim() === '') {
    f.push({ rule: 'CUSTOMER_NAME', severity: 'CONFIRM', path: 'customer.nama', message: 'Nama customer wajib diisi.' });
  }

  return summarize(f);
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — pre-push business rules (server, before enqueue)
//
// These are gated by what Turboly's Service Order form REQUIRES. The form will
// not save without STORE, CUSTOMER, VEHICLE, PLAN SERVICE DATE, PLAN SERVICE
// TIME, SERVICE ADVISOR, SALESPERSON, ODOMETER — so any of those missing is a
// hard BLOCK here rather than a failed push later.
// ─────────────────────────────────────────────────────────────────────────

export interface MirrorView {
  store?: TbStore | null;
  serviceProducts: Map<string, TbServiceProduct>; // keyed by sku
  advisorByName: Map<string, TbMechanic>; // normalized name -> mechanic
  salespersonByName: Map<string, TbMechanic>;
  serviceProductsStale: boolean;
}

export interface Layer2Context {
  mirror: MirrorView;
  /** Resolved advisor/salesperson names captured on the SPK. */
  serviceAdvisorName: string | null;
  salespersonName: string | null;
  /** Whether a plan service date/time has been assigned (defaults allowed). */
  planServiceDate: string | null;
  planServiceTime: string | null;
}

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

export function validateLayer2(doc: SpkDoc, ctx: Layer2Context): ValidationResult {
  const f: Finding[] = [];
  const m = ctx.mirror;

  // STORE must resolve to a real Turboly store.
  if (!m.store) {
    f.push({
      rule: 'MIRROR_STORE_RESOLVES',
      severity: 'BLOCK',
      path: 'branchCode',
      message: `Cabang ${doc.branchCode} belum terpetakan ke Store Turboly.`,
      detail: 'Jalankan import tb_stores dari export Turboly.',
    });
  }

  // Every ordered service line must map to a real SKU.
  const orderedWithSku = doc.jobLines.filter((l) => l.ordered);
  for (const line of orderedWithSku) {
    if (!line.turbolySku) {
      f.push({
        rule: 'SKU_UNMAPPED',
        severity: 'BLOCK',
        path: `jobLines[${line.lineNo}]`,
        message: `Pekerjaan ${line.serviceCode} belum punya SKU Turboly.`,
      });
      continue;
    }
    if (!m.serviceProducts.has(line.turbolySku)) {
      if (m.serviceProductsStale) {
        // A stale mirror must not halt 500 SPKs/day — degrade to WARN.
        f.push({
          rule: 'SKU_NOT_IN_STALE_MIRROR',
          severity: 'WARN',
          path: `jobLines[${line.lineNo}]`,
          message: `SKU ${line.turbolySku} tidak ada di mirror (mirror kadaluarsa).`,
        });
      } else {
        f.push({
          rule: 'SKU_NOT_FOUND',
          severity: 'BLOCK',
          path: `jobLines[${line.lineNo}]`,
          message: `SKU ${line.turbolySku} tidak ditemukan di Turboly.`,
        });
      }
    }
  }

  // ODOMETER required by the form.
  if (doc.vehicle.km.value == null) {
    f.push({ rule: 'ODOMETER_REQUIRED', severity: 'BLOCK', path: 'vehicle.km', message: 'ODOMETER wajib untuk Service Order Turboly.' });
  }

  // SERVICE ADVISOR required by the form — must map to a real Turboly advisor.
  if (!ctx.serviceAdvisorName) {
    f.push({ rule: 'ADVISOR_REQUIRED', severity: 'BLOCK', path: 'serviceAdvisor', message: 'SERVICE ADVISOR wajib (form Turboly).' });
  } else if (!m.advisorByName.has(norm(ctx.serviceAdvisorName))) {
    f.push({
      rule: 'ADVISOR_UNMAPPED',
      severity: 'BLOCK',
      path: 'serviceAdvisor',
      message: `Service Advisor "${ctx.serviceAdvisorName}" tidak cocok dengan data Turboly.`,
    });
  }

  // SALESPERSON required by the form.
  if (!ctx.salespersonName) {
    f.push({ rule: 'SALESPERSON_REQUIRED', severity: 'BLOCK', path: 'salesperson', message: 'SALESPERSON wajib (form Turboly).' });
  } else if (!m.salespersonByName.has(norm(ctx.salespersonName))) {
    f.push({
      rule: 'SALESPERSON_UNMAPPED',
      severity: 'BLOCK',
      path: 'salesperson',
      message: `Salesperson "${ctx.salespersonName}" tidak cocok dengan data Turboly.`,
    });
  }

  // Customer signature blocks INVOICING, not intake.
  if (doc.signatures.menyerahkan.present === false) {
    f.push({
      rule: 'SIG_CUSTOMER_ABSENT',
      severity: 'WARN',
      path: 'signatures.menyerahkan',
      message: 'Tanda tangan customer belum ada — memblokir penagihan, bukan intake.',
    });
  }

  // Schema version guard is enforced in the worker (SCHEMA_VERSION_IN_RANGE);
  // here we only note if it looks out of range for early surfacing.

  return summarize(f);
}

/** Whether a doc is safe to move validated → queued. */
export function isQueueable(l1: ValidationResult, l2: ValidationResult): boolean {
  return !l1.blocked && !l2.blocked;
}
