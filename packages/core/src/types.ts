/**
 * Domain types for the Nawilis SPK -> Turboly bridge.
 *
 * MongoDB is the SYSTEM OF RECORD. The queue holds work, not truth.
 * Every field carries provenance so the review/validation layers can reason
 * about confidence and so nothing is ever silently trusted.
 */

// ─────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────

import type { FlowState } from './flow.js';

/**
 * The intake document kinds. SPK is the v1 paper form; QS is stubbed for
 * later; CHECK_AND_GO is the Flow-v2 vehicle-check intake (one General Check
 * service line, detailed inspection stored in Mongo).
 */
export type DocType = 'SPK_NAWILIS' | 'QS_INSPECTION' | 'CHECK_AND_GO';

export type BranchType = 'NAWILIS' | 'QUICKSERV' | 'COMPANY';

/** How the record was captured. Typed mode is 100% accurate by construction. */
export type CaptureMode = 'typed' | 'photo' | 'hybrid';

/** Provenance of a single field value. Drives the review tier. */
export type FieldSource =
  | 'typed'
  | 'photo_extract'
  | 'history_prefill'
  | 'bulk_ok'
  | 'ticket_scan'
  | 'system';

/**
 * Review tier for a field. AUTO_PASS never stops the operator; CONFIRM asks
 * for a tap; BLOCK stops submission. Computed from validator + model confidence.
 */
export type FieldTier = 'AUTO_PASS' | 'CONFIRM' | 'BLOCK';

/** Lifecycle of the WORK the SPK describes — orthogonal to pipeline `state`. */
export type Lifecycle = 'open' | 'amended' | 'closed';

/**
 * Pipeline state. Every transition is a compare-and-swap (findOneAndUpdate with
 * the expected current state in the filter). See states.ts for the legal graph.
 */
export type PipelineState =
  | 'captured'
  | 'extracted'
  | 'needs_review'
  | 'validated'
  /**
   * Data is complete + valid and stored in Mongo, but the job has NOT yet been
   * given to a mechanic. Parked here — NOT pushed to Turboly. This is the
   * "intermediate in DB" holding state. Only assignment releases it to `queued`.
   */
  | 'awaiting_assignment'
  | 'queued'
  | 'pushing'
  | 'pushed'
  | 'confirmed'
  | 'failed'
  | 'manual_intervention'
  | 'amend_pending'
  | 'voided'
  | 'superseded';

export const TERMINAL_STATES: readonly PipelineState[] = ['confirmed', 'voided', 'superseded'];

/** Which world's ingress mechanism is active. */
export type PushMode = 'rpa' | 'api' | 'manual';

/** Tri-state condition of a vehicle-checkin row. Default UNMARKED, never OK. */
export type ConditionStatus = 'OK' | 'ISSUE' | 'UNMARKED';

// ─────────────────────────────────────────────────────────────────────────
// Sub-documents
// ─────────────────────────────────────────────────────────────────────────

export interface FieldMetaEntry {
  /** Dotted path into the document, e.g. "customer.waE164". */
  path: string;
  source: FieldSource;
  /** 0..1 model confidence for photo_extract; null otherwise. */
  modelConfidence: number | null;
  /** Result of the deterministic validator for this field. */
  validator: 'pass' | 'warn' | 'fail' | 'skip';
  tier: FieldTier;
  /** How many times a human edited this field during review. */
  corrections: number;
}

export interface CaptureInfo {
  mode: CaptureMode;
  operator: { userId: string; pin: 'verified' | 'skipped' };
  /** What the advisor says (editable). NOT the same as capturedAt. */
  arrivalTime: string; // ISO
  /** Device clock at capture. */
  capturedAt: string; // ISO
  /** Server clock at ingest — authoritative. */
  receivedAt: string; // ISO
  /** receivedAt - arrivalTime, in minutes. Best adoption telemetry we have. */
  captureLagMinutes: number;
  /** Asia/Jakarta calendar day of receivedAt. Dashboards ONLY, never a recon key. */
  businessDate: string; // YYYY-MM-DD
}

export interface CustomerInfo {
  nama: string;
  waE164: string | null;
  /** Canonical phone identity key (digits, 62/0 stripped) — the person's pkey. */
  phoneKey?: string | null;
  alamat: string | null;
  kontakLain?: string | null;
  /** Resolved during push; null until the customer exists in Turboly. */
  turbolyCustomerId: string | null;
  consent: { marketing: boolean; at: string | null };
}

export interface Odometer {
  /** Raw as written, e.g. "45.230" (id-ID: '.' = thousands). */
  raw: string;
  /** Parsed integer, e.g. 45230. Push THIS, never the formatted string. */
  value: number;
}

export interface VehicleInfo {
  noPolisi: {
    /** Canonical no-space form for keys/search, e.g. "B1234SZA". */
    full: string;
    /** Display form matching Turboly's spacing convention, e.g. "B 1234 SZA". */
    display: string;
    /** Non-empty ⇒ tier is capped at CONFIRM regardless of history agreement. */
    correctionsApplied: string[];
  };
  /** OCR-confusion neighbourhood for multikey lookup. */
  plateVariants: string[];
  merkNormalized: string | null;
  merkRaw: string | null;
  merkMatchScore: number | null;
  tipeNormalized: string | null;
  tahun: number | null;
  warna: string | null;
  /** 'car' | 'motorcycle' (absent on docs captured before 2026-08-08 = car). */
  kind?: 'car' | 'motorcycle';
  km: Odometer;
  /** Operator confirmed on the form: create this NEW make in Turboly at push. */
  createMakeConfirmed?: boolean;
  /**
   * Nomor rangka / VIN — asked for on ELECTRIC vehicles only. An EV has no engine
   * number, so this is the one field that separates two identical cars. Optional:
   * every petrol SPK ever captured has none.
   */
  vin?: string | null;
  /** Stable per-vehicle ref (cross-branch), e.g. "veh_B1234SZA". */
  vehicleRef: string | null;
  /** Why we bound to an existing vehicle doc — requires two independent signals. */
  bindReason: string | null;
}

export interface JobLine {
  lineNo: number;
  /** One of the 12 pre-printed service codes, or a custom code for rows 13-14. */
  serviceCode: string;
  ordered: boolean;
  qty: number;
  keterangan: string | null;
  /** Mechanic — NOT known at intake; filled at ticket-QR scan during the job. */
  mk: { mechanicCode: string | null; source: 'pending_ticket_scan' | 'ticket_scan' | 'typed' };
  /** Duration — also filled at ticket scan / closure. */
  waktu: { minutes: number | null; source: 'pending_ticket_scan' | 'ticket_scan' | 'typed' };
  /** Quoted at intake, printed on the ticket, pushed to the SO line. */
  quotedPrice: number | null;
  /** Turboly Service Product SKU — from the tenant export ONLY. Never invented. */
  turbolySku: string | null;
}

export interface ConditionCheck {
  rowNo: number;
  /** e.g. "PANEL_DASHBOARD", "BODY_KENDARAAN". */
  item: string;
  /** Words circled on the row, e.g. ["BARET","PENYOK"]. */
  marks: string[];
  status: ConditionStatus;
  source: FieldSource | null;
}

export interface SignatureInfo {
  present: boolean;
  /** Computed on-device at capture; the blob is evidence, not the input. */
  inkDensity?: number;
  computedAt?: 'device' | 'server';
  namaJelas?: string | null;
  /** On-glass drawn signature (small-canvas PNG data URL). */
  imageDataUrl?: string | null;
}

export interface PushPhase {
  status: 'pending' | 'committed' | 'failed' | 'deferred';
  at?: string;
  turbolyDocNo?: string | null;
  error?: string | null;
}

export interface PushInfo {
  /**
   * Set when a doc was reclaimed from `pushing` after its runner died. Its
   * Turboly outcome is UNKNOWN — the Save may already have committed — so the
   * next claim must prove the order is absent before creating another one.
   */
  reclaimed?: boolean;
  /** Written INTO Turboly (reference field). The sole identity used for read-back. */
  correlationToken: string;
  /** QuickServ 95 / Nawilis 50 — QS jobs finish before a lagged SWO would exist. */
  priority: number;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** Fencing lease. epoch is re-asserted before every irreversible click. */
  lease: { workerId: string | null; epoch: number; expiresAt: string | null };
  claimedAt?: string | null;
  phases: { order: PushPhase; workOrder: PushPhase };
  storeSwitch: { expected: string; observed: string | null; verifiedFrom: string };
  failureClass?: FailureClass | null;
  lastError?: string | null;
  /**
   * Last attempt to APPEND this SPK onto the same car's Check & Go order
   * instead of creating one (see pushRunner). fellBack=true means nothing
   * irreversible had happened and a separate order was created as before.
   */
  mergeAttempt?: { at: string; targetSpkId: string; error: string | null; failureClass: FailureClass | null; fellBack: boolean } | null;
  /** When this SPK FIRST held for its car's Check & Go. The cap is measured from here — never from the Check & Go's own updatedAt, which every retry rewrites. */
  mergeHoldSince?: string | null;
}

export type FailureClass = 'transient' | 'auth' | 'data' | 'structural' | 'infra';

export interface TurbolyReadback {
  serviceOrderNo: string | null;
  workOrderNo: string | null;
  /** Absolute URL of the created SO detail page, captured on save for direct read-back. */
  serviceOrderUrl?: string | null;
  /**
   * Set when this SPK's lines were APPENDED to an existing Check & Go Service
   * Order instead of creating one of its own (Jane, Turboly, 2026-08-18: "if
   * same car then should be 1 SRO"). serviceOrderNo above then holds the
   * Check & Go's number; serviceOrderUrl stays null on purpose — the URL is
   * unique per doc (uq_turboly_so_url) and belongs to the Check & Go doc.
   */
  mergedInto?: {
    /** The Check & Go doc whose Service Order received the lines. */
    spkId: string;
    serviceOrderUrl: string;
    serviceOrderNo: string | null;
    at: string;
    /** What a human still has to do about this merge (WO already made, notes not carried, approval reset). Shown on the board. */
    warnings?: string[];
  } | null;
  readback: {
    matchedOn: string[];
    lineCount: number | null;
    lineSkus: string[];
    km: number | null;
  };
}

export interface Amendment {
  at: string;
  by: string;
  added?: string[];
  removed?: string[];
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Check & Go (CHECK_AND_GO docs)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One line of the inspection checklist. This is the FLAT, human-readable view:
 * `item` + `catatan` are the only fields that reach Turboly (the worker joins
 * them into the pushed inspection line), so both must read as finished
 * sentences on their own.
 */
export interface CheckGoInspectionItem {
  item: string;
  /**
   * What the checker found at intake (Pass/Fail, GOOD/RECHARGE/REPLACE, …) —
   * deliberately NOT `feedback`, which belongs to the mechanic.
   */
  hasil?: string | null;
  catatan: string | null;
  /** Mechanic result, filled during the job via the flow board. */
  feedback: 'pass' | 'fail' | null;
  recommendation: string | null;
  inspected: boolean;
}

/**
 * The printed "NAWILIS CHECK and GO REPORT" exactly as it was filled in, stored
 * as refdata CODES (see apps/web/lib/refdata.client.ts). This is the lossless
 * original; `CheckGo.inspectionItems` is a derived projection of it, so the
 * labels can be re-printed without rewriting stored documents. Only answers
 * someone actually gave are kept — an untouched report is stored as null.
 */
export interface CheckGoReport {
  /**
   * Sections 1-7 of the final-3 sheet. `verdict` on the section is the
   * section-spanning pair (Oli Mesin: BAGUS/KOTOR; ATF: JERNIH/KOTOR); most
   * sections carry verdicts per ITEM instead. All verdicts are CODES from the
   * refdata tables — first option of a pair is the healthy one.
   */
  sections: Array<{
    code: string;
    verdict: string | null;
    items: Array<{ code: string; verdict: string | null; readings: Array<{ code: string; value: string }> }>;
    /** Picked recommendation codes for this section. */
    rekomendasi: string[];
    /** The free-text a freeText option carries ("Ganti lampu …"). */
    rekomendasiLain: string | null;
    /** "Part suspensi yang harus diganti" lines (Lain-Lain only). */
    extraParts: string[];
  }>;
  /** Section 8 — one entry per wheel that had anything written on it. */
  tires: Array<{
    position: string;
    merkUkuran: string | null;
    /** LEBIH | CUKUP | KURANG — CUKUP is the healthy one. */
    tekanan: string | null;
    /** Measured pressure as written ("26"), psi. Absent on older documents. */
    psi?: string | null;
    /** Ticked damage marks (AUS_TIDAK_RATA, RETAK). */
    flags: string[];
  }>;
  /** The tire recommendation checklist + its blank "□ ___" lines. */
  tireRekomendasi: { picks: string[]; lain: string[] };
  /**
   * The door-placard standard pressure ("33/36"), one per vehicle — the value
   * a measured psi is compared against. Absent on older documents.
   */
  tekananStandar?: string | null;
}

export interface CheckGo {
  /** When the checklist reached the Service Order's Inspections tab (ours or the order it merged into). */
  inspectionsFilledAt?: string | null;
  /** Why it did not, if it did not — so a missing list is visible instead of living only in a CI log. */
  inspectionError?: string | null;
  harga: number;
  inspectionItems: CheckGoInspectionItem[];
  /** null when the checklist was left blank — see CheckGoReport. */
  report?: CheckGoReport | null;
  /** Mechanic chosen at intake; the CODE is what Turboly matches a WO on. */
  mechanicCode?: string | null;
  mechanicName?: string | null;
  /** Set by the worker's "Tetap Check Saja" action — no repair will follow. */
  stayCheckOnly?: boolean;
  stayCheckOnlyAt?: string;
  /** Set by the worker once the checklist has been pushed onto the Turboly SO. */
  inspectionsPushedAt?: string;
  /** SPK docs whose lines were appended onto this Check & Go's Service Order. */
  mergedSpkIds?: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// The SPK document
// ─────────────────────────────────────────────────────────────────────────

export interface SpkDoc {
  /** ULID. THE primary key. NOT the paper serial. */
  _id: string;
  schemaVersion: number;
  docType: DocType;
  tenantId: string;

  /** Client-generated idempotency key for the capture write. Unique index. */
  uploadId?: string;

  /** Daily queue number per outlet, e.g. "20260401001" (matches Nawilis export). */
  nomorAntrian?: string;

  /**
   * The complete raw form as entered — a verbatim copy of every field on the SPK
   * sheet (per-service qty/ket, oil/tyre brands, previous-oil, nama_cs, etc.),
   * so the Nawilis-schema export can be reproduced exactly and nothing is lost.
   */
  rawForm?: Record<string, unknown>;

  branchCode: string; // from session + device binding, never the checkbox column
  branchType: BranchType;
  deviceBindingVerified: boolean;

  spkNumber: { normalized: string | null; source: FieldSource };
  qr: { payload: string | null; kind: 'unknown' | 'static_link' | 'serial' };

  capture: CaptureInfo;
  customer: CustomerInfo;
  vehicle: VehicleInfo;
  complaint: { keluhan: string | null };

  jobLines: JobLine[];
  jobLineSummary: { orderedCount: number; unmappedCount: number; quotedTotal: number };

  conditionChecks: ConditionCheck[];
  damageDiagram: { imageRef: string | null; neverReviewed: boolean };
  signatures: { menyerahkan: SignatureInfo; menerima: SignatureInfo };
  authorization: { accepted: boolean; acceptedBasis: AuthBasis; textVersion: string };

  rekomendasiService?: { text: string | null };
  estimasi?: { minutes: number | null };

  fieldMeta: FieldMetaEntry[];

  lifecycle: Lifecycle;
  amendments: Amendment[];

  /**
   * Set the moment the job is given to a mechanic (ticket-QR scan at job start,
   * or the ops console). This is the gate that releases the record from
   * `awaiting_assignment` to `queued` — only assigned jobs are pushed to Turboly.
   */
  assignment: {
    assignedAt: string;
    assignedBy: string;
    primaryMechanicCode: string;
    via: 'ticket_scan' | 'console';
  } | null;

  state: PipelineState;
  push: PushInfo;
  turboly: TurbolyReadback;

  /**
   * FLOW v2 (additive, optional): full Turboly lifecycle position after the
   * SO exists — Approve SO → WO → QC → Invoice. See packages/core/src/flow.ts.
   */
  flow?: FlowState;

  /**
   * CHECK_AND_GO docs only (additive, optional): the typable General Check
   * price + the detailed inspection checklist kept in OUR Mongo (Turboly only
   * stores the summary). Rows are written at intake; feedback/recommendation/
   * inspected are filled by the mechanic during the job.
   */
  checkGo?: CheckGo;

  /** Salesperson for Turboly's separate Salesperson field (defaults to advisor). */
  salespersonName?: string | null;

  /** Optional appointment time (ISO). Future value drives Turboly's plan date/time. */
  scheduledAt?: string | null;

  /** Legal hold flag — deletion job must honour this. */
  legalHold?: boolean;

  createdAt: string;
  updatedAt: string;
}

export type AuthBasis = 'wet_signature' | 'on_glass' | 'verbal_recorded';

// ─────────────────────────────────────────────────────────────────────────
// Companion collection docs
// ─────────────────────────────────────────────────────────────────────────

export interface SpkEvent {
  _id: string;
  spkId: string;
  at: string;
  type: string;
  by: string;
  /** For labelled-correction corpus + audit trail. */
  data?: Record<string, unknown>;
}

/** Claim table row. _id = `${spkId}#${phase}` makes double-push structurally hard. */
export interface TurbolyClaim {
  _id: string; // `${spkId}#order` | `${spkId}#workOrder`
  spkId: string;
  phase: 'order' | 'workOrder';
  correlationToken: string;
  claimedBy: string;
  epoch: number;
  claimedAt: string;
  committedAt: string | null;
  turbolyDocNo: string | null;
}

export interface VehicleDoc {
  _id: string; // vehicleRef
  plateFull: string;
  plateVariants: string[];
  merk: string | null;
  tipe: string | null;
  tahun: number | null;
  warna: string | null;
  lastKm: number | null;
  lastSeenAt: string | null;
  lastBranch: string | null;
  visitCount: number;
  customerRefs: string[];
}

/**
 * A branch added AFTER the app was built.
 *
 * The 27 branches in REF_BRANCHES are compiled in, which is what makes the
 * intake forms work with no network at a counter. A branch that opens later
 * cannot wait for a deploy, so it lands here instead and is merged on top of
 * that list — same shape, so nothing downstream can tell the two apart.
 */
export interface BranchRow {
  _id: string; // branchCode, e.g. NWL-XXX
  name: string;
  type: BranchType;
  docAbbrev: string | null;
  turbolyStoreNameGuess: string;
  /** Who added it and when — this is the one list a typo can quietly break. */
  addedAt: string;
  addedBy: string | null;
}

/** Turboly master-data mirror rows (tb_*). Built from UI export, never scraped blind. */
export interface TbStore {
  _id: string; // branchCode
  turbolyStoreId: string;
  turbolyStoreName: string;
  syncedAt: string;
}

export interface TbServiceProduct {
  _id: string; // sku
  sku: string;
  name: string;
  type: string | null;
  taxCode: string | null;
  price: number | null;
  masterDurationMin: number | null;
  storeCode: string | null; // null = tenant-wide
  syncedAt: string;
}

export interface TbMechanic {
  _id: string; // mechanicCode
  mechanicCode: string;
  name: string;
  storeCode: string | null;
  role: string | null;
  syncedAt: string;
}

/** Maps our SPK service code → a real Turboly Service Product SKU (per branch or tenant-wide). */
export interface ServiceSkuMap {
  _id: string; // `${branchCode|*}:${serviceCode}`
  branchCode: string | null; // null = tenant-wide default
  serviceCode: string;
  sku: string;
  matchScore: number;
  confirmed: boolean; // human-approved; unconfirmed maps are WARN, not trusted blindly
  updatedAt: string;
}

/** Singleton controlling the degradation ladder rung. */
export interface DegradationState {
  _id: 'degradation';
  rung: 0 | 1 | 2 | 3;
  since: string;
  reason: string;
  lastCanaryHash: string | null;
  lastCanaryOkAt: string | null;
  updatedAt: string;
}

export interface TbCredential {
  _id: string; // branchCode
  branchCode: string;
  username: string;
  /** AES-256-GCM ciphertext (base64). Decrypted only in the worker with CREDENTIAL_ENC_KEY. */
  passwordEnc: string;
  totpSecretEnc?: string | null;
  updatedAt: string;
}

export interface ReconRun {
  _id: string;
  ranAt: string;
  windowHours: number;
  missingInTurboly: string[];
  extraWithOurToken: string[];
  extraNoToken: number;
  stuck: number;
  /** SPKs whose lines live on the car's Check & Go order — counted, never alerted (optional: older runs predate the merge). */
  mergedIntoCheckGo?: number;
  alertsFired: string[];
}

export interface DlqItem {
  _id: string;
  spkId: string;
  phase: 'order' | 'workOrder';
  failureClass: FailureClass;
  turbolyError: string;
  attempts: number;
  enqueuedAt: string;
  resolvedAt: string | null;
}
