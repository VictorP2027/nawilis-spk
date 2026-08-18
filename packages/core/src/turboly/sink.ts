import type { SpkDoc } from '../types.js';

/**
 * The fully-resolved, Turboly-facing payload. The worker builds this from an
 * SpkDoc + the tb_* mirror, so the sink is purely mechanical DOM-driving and
 * has no business logic. Every string here is exactly what gets typed.
 */
export interface TurbolyServiceOrderPayload {
  spkId: string;
  correlationToken: string;
  storeName: string;
  storeTurbolyId: string; // numeric option value for <select id="store-id">, e.g. "8339"
  type: string; // default "General"
  customer: { existingQuery: string | null; create: { nama: string; phone: string; alamat: string } | null };
  vehicleRegistration: string; // display plate, matching Turboly spacing
  /** No-space plate for the create-vehicle form + search, e.g. "B1234SZA". */
  vehiclePlateFull?: string;
  /** 'car' | 'motorcycle' — drives Turboly's #vehicle-type-select for NEW vehicles. */
  vehicleKind?: 'car' | 'motorcycle';
  /** Details for creating a brand-new vehicle when it isn't already in Turboly. */
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: string;
  vehicleColor?: string;
  /** Nomor rangka / VIN — electric vehicles only; absent everywhere else. */
  vehicleVin?: string;
  /** Operator confirmed on the form: create the NEW make (+ a first model) in Turboly if missing. */
  createMakeConfirmed?: boolean;
  odometer: string;
  planServiceDate: string; // formatted for the date field, e.g. "31-07-2026"
  planServiceTime: string; // e.g. "09:30"
  serviceAdvisorName: string;
  salespersonName: string;
  referenceNumber: string; // == correlationToken
  notes: string;
  serviceLines: Array<{ serviceName: string; description: string; qty: number; priceIncTax: number | null; discount: number | null; expectedSku: string }>;
  sparepartLines: Array<{ productName: string; qty: number; priceIncTax: number | null; expectedSku: string }>;
}

/**
 * ServiceOrderSink — the swappable ingress contract.
 *
 * The whole system is built so the ingress mechanism is ONE class:
 *   - RpaSink     (W2) drives the real Turboly web UI via Playwright.
 *   - ApiSink     (W1) calls a Turboly API/CSV import, if one is ever granted.
 *   - ManualSink  (W3) records that a human must enter it, and stores the doc no.
 *
 * The worker never knows which is active. Swapping worlds = swapping the sink.
 */

export interface PushContext {
  /** Worker identity + fencing epoch — re-asserted before every irreversible click. */
  workerId: string;
  epoch: number;
  /** Whether to advance the SO from DRAFT → APPROVED after saving. */
  approve: boolean;
  /** Abort if the lease is about to expire (ms since epoch). */
  leaseExpiresAt: number;
}

export interface PushResult {
  ok: boolean;
  /** Turboly's generated Service Order document number, captured on save. */
  serviceOrderNo: string | null;
  workOrderNo: string | null;
  /** Absolute URL of the created SO detail page (for direct, independent read-back). */
  serviceOrderUrl?: string | null;
  /** What the read-back verified against. */
  verified: {
    matchedOn: string[];
    lineCount: number | null;
    lineSkus: string[];
    km: number | null;
    store: string | null;
  } | null;
  failureClass?: 'transient' | 'auth' | 'data' | 'structural' | 'infra';
  error?: string;
  /** Evidence: path to a screenshot taken at submit. */
  screenshotRef?: string | null;
  /**
   * DRAFT→APPROVED outcome when the push asked for it, VERIFIED (not just
   * "the click didn't throw"): true = approved, false = still Draft, null =
   * approval wasn't requested. A false here never fails the push — the order
   * exists, and a retry would create a second one.
   */
  approved?: boolean | null;
}

export interface VerifyResult {
  found: boolean;
  serviceOrderNo: string | null;
  /**
   * The order page the token was found on. A doc reclaimed after its runner
   * died mid-push knows its number but not its URL, and without the URL the
   * next SPK for that car cannot merge into it — the feature would fail open
   * and create the second order it exists to prevent.
   */
  serviceOrderUrl?: string | null;
  store: string | null;
  lineCount: number | null;
  lineSkus: string[];
  km: number | null;
}

/**
 * Where an SPK's lines should land when the same car already has an open
 * Check & Go Service Order (Jane, Turboly, 2026-08-18: "if same car then
 * should be 1 SRO").
 */
export interface AppendTarget {
  /** Absolute URL of the Check & Go's SO detail page. */
  serviceOrderUrl: string;
  /** No-space plate the SO must show, e.g. "B1234SZA" — proven on the page before anything is typed. */
  expectedPlate: string;
  /**
   * This SPK's correlation token. Written into the first appended service line's
   * description so the SO page carries it afterwards — that is what makes a
   * retry able to see "already appended" instead of appending twice.
   */
  spkToken: string;
}

export interface AppendResult {
  ok: boolean;
  /** The Check & Go SO's number, read off the page. */
  serviceOrderNo: string | null;
  /**
   * true when the token was already on the SO before we touched anything: a
   * previous attempt appended and died before recording it. Nothing was typed.
   */
  alreadyAppended?: boolean;
  /**
   * The append could not even START (SO not found, plate mismatch, controls
   * missing, SO closed): nothing irreversible happened, so the caller may fall
   * back to creating a separate SO exactly as before this feature existed.
   * NEVER set after Save was clicked.
   */
  fallbackToCreate?: boolean;
  failureClass?: 'transient' | 'auth' | 'data' | 'structural' | 'infra';
  error?: string;
  screenshotRef?: string | null;
  /**
   * false when the SPK's notes (complaint, custom lines) could not be written
   * because the order's edit page renders no notes field (an APPROVED order).
   * The lines still landed; only the free text did not travel.
   */
  notesCarried?: boolean;
  /** The order was APPROVED and the edit sent it back to PENDING APPROVAL — a human must re-approve. */
  approvalReset?: boolean;
  /** The Check & Go's inspection list had rows before the append and fewer after — never expected; re-fill from Mongo. */
  inspectionsLost?: boolean;
}

export interface ServiceOrderSink {
  readonly mode: 'rpa' | 'api' | 'manual';
  /** Create (and optionally approve) the Service Order from a resolved payload. */
  pushServiceOrder(payload: TurbolyServiceOrderPayload, ctx: PushContext): Promise<PushResult>;
  /**
   * OPTIONAL. Append the payload's service + sparepart lines to an EXISTING
   * Service Order (the same car's Check & Go). Sinks that cannot edit an
   * existing order simply omit it and the runner creates a separate SO.
   */
  appendLinesToServiceOrder?(target: AppendTarget, payload: TurbolyServiceOrderPayload, ctx: PushContext): Promise<AppendResult>;
  /**
   * Independent read-back by correlation token — MUST run in a fresh context,
   * never reusing the write session. Sets `confirmed`, nothing else may.
   */
  verifyByToken(doc: SpkDoc): Promise<VerifyResult>;
  /** Structural canary: does the SO form still look the way we expect? */
  canary(): Promise<{ ok: boolean; controlHash: string; detail?: string }>;
  dispose?(): Promise<void>;
}
