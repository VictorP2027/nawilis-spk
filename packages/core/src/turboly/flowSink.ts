import type { Page } from 'playwright';
import { SELECTOR_MAP as S } from './selmap.js';
import { resolve, exists } from './locators.js';
import { TurbolySession } from './session.js';
import { DataError, TransientError } from './rpaSink.js';
import { registerRetailHttp, registerWholesaleHttp, type HttpRegisterConfig, type HttpRegisterResult } from './httpRegister.js';
import { canonPhoneKey, localPhone } from '../indonesia.js';

/**
 * FLOW v2 — browser automation for the Turboly lifecycle AFTER the Service
 * Order exists: Approve SO → Create Work Order → Start → Complete → QC →
 * Invoice → Complete Invoice, plus Inspections and Customer registration.
 *
 * Mirrors rpaSink conventions (ONE session/page, waitForTimeout pacing,
 * inline-error reads, screenshots via PUSH_SCREENSHOT_DIR) but the WO /
 * invoice / customer pages are NOT yet selector-mapped. Everything here is
 * therefore DISCOVERY-FRIENDLY best-effort: controls are found by visible
 * text, and when a control is missing we throw a DiscoveryError whose message
 * LISTS the visible buttons/fields on the page, so live testing iterates fast.
 *
 * Error contract (same philosophy as rpaSink, for the flow worker to classify):
 *   - DiscoveryError  → structural: the expected control wasn't on the page.
 *   - DataError       → Turboly rejected the input; retrying won't help.
 *   - TransientError  → flaky search/timeout; retry later.
 *   - AuthChallengeError (from session.ensureLoggedIn) → auth.
 */

// ─────────────────────────────────────────────────────────────────────────
// Public arg/result shapes
// ─────────────────────────────────────────────────────────────────────────

export interface CreateWorkOrderResult {
  workOrderNo: string | null;
  workOrderUrl: string;
  /** Non-fatal discovery notes (e.g. assignee control not found on a created WO). */
  note?: string;
}

export interface CreateInvoiceResult {
  invoiceNo: string | null;
  invoiceUrl: string;
}

export interface CompleteWorkOrderArgs {
  waktuMinutes: number;
  feedback: string;
}

export interface QcApproveArgs {
  nextOdometer?: number | null;
  nextServiceDateISO?: string | null;
  recommendations?: string | null;
}

export interface CompleteInvoiceArgs {
  /** Visible option text on the payment-method control, e.g. "Cash". */
  method: string;
  amount: number;
}

export interface InspectionItemInput {
  category: string;
  description: string;
  /** e.g. 'pass' | 'fail' (visible option text on the feedback control). */
  feedback?: string | null;
  recommendation?: string | null;
}

export interface RegisterRetailArgs {
  nama: string;
  phone: string;
  alamat: string;
  /** Turboly store id (native select value) — first registration store, kept forever. */
  storeTurbolyId?: string | null;
  /** Link to a wholesale company (corporate customers only). */
  companyName?: string | null;
  /**
   * The company's Turboly id, when the corporate flow already knows it. The
   * HTTP path links by id (exact); the browser path can only pick by visible
   * name, so both are passed and neither replaces the other.
   */
  companyId?: string | null;
}

export interface RegisterCustomerResult {
  customerId: string | null;
  customerUrl: string;
  /** True when an existing record was found (dedupe) — nothing was created. */
  existing?: boolean;
  note?: string;
}

export interface RegisterWholesaleArgs {
  companyName: string;
  picName: string;
  npwp: string;
  alamat: string;
  advisorName: string;
  /** When given, the linked RETAIL customer is registered right after. */
  retail?: Omit<RegisterRetailArgs, 'companyName'> | null;
}

export interface RegisterWholesaleResult {
  companyId: string | null;
  companyUrl: string;
  retail?: RegisterCustomerResult;
  /** True when the company already existed (dedupe) — it was NOT re-created. */
  existing?: boolean;
  note?: string;
}

/** The expected control was not on the page — message lists what WAS visible. */
export class DiscoveryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DiscoveryError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP fast path policy
// ─────────────────────────────────────────────────────────────────────────

/**
 * The one switch that takes customer registration back to the browser.
 * Defaults ON: the browser path costs ~2 minutes and holds the single Turboly
 * session for every one of them, so any other login kills it mid-form.
 */
function httpRegisterEnabled(): boolean {
  const raw = (process.env.TURBOLY_HTTP_REGISTER ?? '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(raw);
}

/**
 * Errors httpRegister raises while BUILDING the request — our reading of the
 * form was wrong, so the browser (which runs the page's own JS: select2 remote
 * lists, the address modal) may well succeed where the scraper could not.
 *
 * It reports these as DataError, the same class it uses for "Turboly rejected
 * our values", so the split has to be made on the message. Every pattern here
 * is thrown BEFORE the POST, which is what makes falling back safe: nothing was
 * written, so the browser cannot create a second customer. Nothing raised after
 * the POST ("… ditolak Turboly: …", "simpan tidak terkonfirmasi") may ever be
 * added to this list.
 */
const HTTP_FORM_UNREADABLE: RegExp[] = [
  /form customer tidak ada/i,
  /authenticity_token tidak ada/i,
  /template baris alamat/i,
  /kontrol .{0,40} tidak ada di form/i,
  /SALES TAX tidak bisa diset ke PPN/i,
  // An empty option list is the scraper seeing nothing, not Turboly refusing a
  // value: a select2 filled by remote JS renders as <select> with no options.
  /Pilihan:\s*\(kosong\)/i,
  // Nothing was posted yet, and the browser has its own stored session — so a
  // failed HTTP login is worth the slow path rather than a review ticket.
  /Login Turboly ditolak|Kredensial Turboly belum diisi/i,
];

/**
 * Should this HTTP failure fall back to the browser?
 *
 * - TransientError: the vendor or the session is the problem. A browser attempt
 *   would hit the same outage, only 2 minutes slower — let it requeue.
 * - DataError: Turboly rejected our values; the browser posts the same values
 *   and gets the same rejection. Surface it, EXCEPT for the pre-POST parse
 *   failures above.
 * - anything else (a TypeError out of the regex scanning, a dead socket): our
 *   HTTP assumption broke in a way nobody classified. Fall back — but only
 *   after the caller has re-checked for a customer the failed attempt may
 *   still have created.
 */
function shouldFallBackToBrowser(err: unknown): boolean {
  if (err instanceof TransientError) return false;
  if (err instanceof DataError) return HTTP_FORM_UNREADABLE.some((re) => re.test(err.message));
  return true;
}

/**
 * A vendor-side error page rather than Turboly.
 *
 * A 502 today rendered a blank page, and the job died with the useless
 * 'Tombol terlihat: [TIDAK ADA tombol terlihat]' — a review ticket for an
 * outage that fixed itself in minutes. `body` is null when the read itself
 * failed (that is not evidence of anything); '' means the page really is blank.
 * Proxy error pages are tiny, so the length guard keeps a real Turboly page
 * that merely mentions "gateway" out of this.
 */
function isVendorOutagePage(status: number, body: string | null, title: string): boolean {
  if (status >= 500) return true;
  if (body !== null && body.trim() === '') return true;
  const text = `${title}\n${(body ?? '').length < 4000 ? (body ?? '') : ''}`;
  // A BARE "502" is not enough: Indonesian amounts are dot-grouped, so an
  // invoice showing Rp 1.502.000 would read as an outage and stall the job
  // forever on a page that is perfectly fine. The number only counts next to
  // error wording.
  return /bad gateway|gateway time-?out|service unavailable|temporarily unavailable|cloudflare|\bnginx\b|\b(error|http)\s*50[234]\b|\b50[234]\s+(bad|service|gateway|error)\b/i.test(
    text,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The RPA class
// ─────────────────────────────────────────────────────────────────────────

export class TurbolyFlowRpa {
  constructor(
    private readonly session: TurbolySession,
    private readonly opts: { screenshotDir?: string } = {},
  ) {}

  private get screenshotDir(): string | undefined {
    return this.opts.screenshotDir ?? process.env.PUSH_SCREENSHOT_DIR ?? undefined;
  }

  private get baseUrl(): string {
    return (this.session as unknown as { cfg?: { baseUrl?: string } }).cfg?.baseUrl ?? 'https://sandbox.turboly.com';
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }

  // ── lifecycle methods ────────────────────────────────────────────────────

  /** DRAFT/DIAGNOSIS → APPROVED on the Service Order page. Idempotent. */
  async approveServiceOrder(serviceOrderUrl: string): Promise<void> {
    const page = await this.open(serviceOrderUrl, 'so-approve');
    if (await this.statusVisible(page, /\bAPPROVED\b/i)) return; // already there
    let clicked = false;
    if (await exists(page, S.actions.approve, 3000)) {
      clicked = await resolve(page, S.actions.approve)
        .first()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked) await this.clickControl(page, /^approved?$/i, 'tombol Approve di Service Order');
    await page.waitForTimeout(1200);
    await this.confirmModals(page);
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-so-approved');
    await this.verifyStatus(page, /\bAPPROVED\b/i, 'Approve Service Order');
    await this.session.noteJobDone();
  }

  /**
   * Create the Service Work Order from an APPROVED SO and set the assignee
   * (mechanic) on every service line. The create control is discovered by
   * text; if the WO got created but the assignee control can't be found, we
   * return successfully WITH a note (never a retry that would duplicate the WO).
   */
  async createWorkOrder(serviceOrderUrl: string, assigneeName: string): Promise<CreateWorkOrderResult> {
    const page = await this.open(serviceOrderUrl, 'wo-create-from-so');
    // Idempotency read-back BEFORE the irreversible click: a previous attempt
    // may have clicked create and died (kick/timeout) before reporting back.
    // If the SO already links to an SWO, return it — NEVER create a second one.
    const already = await this.findLinkedDocOnPage(page, /service_work_orders\/\d+/, /^SWO\//);
    if (already) {
      await this.session.noteJobDone();
      return {
        workOrderNo: already.no,
        workOrderUrl: already.url,
        note: 'Work Order sudah ada di SO ini — tidak dibuat ulang (guard duplikat)',
      };
    }
    await this.clickControl(
      page,
      /create\s*(service\s*)?work\s*order|buat\s*work\s*order|\+\s*work\s*order/i,
      'tombol Create Work Order di SO (harus APPROVED dulu)',
    );
    await page.waitForTimeout(1500);
    await this.confirmModals(page);
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-wo-after-create-click');

    const notes: string[] = [];

    // Wherever we landed (WO form or WO detail), try to set the assignee.
    if (/service_work_orders\/\d+/.test(page.url())) {
      // Detail page — assignee may need Edit mode.
      const edited = await this.clickControlIfPresent(page, /^edit$/i);
      if (edited) await page.waitForTimeout(2200);
    }
    const assigned = await this.trySetAssignees(page, assigneeName);
    if (!assigned) {
      notes.push(
        `kontrol Assignee/mekanik TIDAK ditemukan — set manual di Turboly. Kontrol terlihat: ${await this.controlHints(page)}`,
      );
    }

    // A form flow needs a save; a direct-created detail page may not.
    const saved = await this.clickControlIfPresent(page, /^(save|simpan|update)$/i);
    if (saved) {
      await page.waitForTimeout(1500);
      await this.confirmModals(page);
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    await this.snapshot(page, 'flow-wo-created');

    const inline = await this.readInlineError(page);
    if (inline) throw new DataError(`Create Work Order ditolak Turboly: ${inline}`);
    if (!/service_work_orders\/\d+/.test(page.url())) {
      throw new DiscoveryError(
        `Work Order tidak terbentuk — setelah klik create URL masih ${page.url()}. ` +
          `Tombol terlihat: ${await this.buttonList(page)}`,
      );
    }
    const workOrderNo = await this.captureDocNo(page, /^SWO\//);
    await this.session.noteJobDone();
    const res: CreateWorkOrderResult = { workOrderNo, workOrderUrl: page.url() };
    if (notes.length) res.note = notes.join(' • ');
    return res;
  }

  /** WAITING → IN PROGRESS (the Start button stamps START DATE). Idempotent. */
  async startWorkOrder(workOrderUrl: string): Promise<void> {
    const page = await this.open(workOrderUrl, 'wo-start');
    if (await this.statusVisible(page, /IN\s*PROGRESS/i)) return;
    await this.clickControl(page, /^start$|^mulai$/i, 'tombol Start di Work Order');
    await page.waitForTimeout(1200);
    await this.confirmModals(page);
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-wo-started');
    await this.verifyStatus(page, /IN\s*PROGRESS/i, 'Start Work Order');
    await this.session.noteJobDone();
  }

  /**
   * IN PROGRESS → WAITING FOR QC: edit → duration (waktu) + feedback per line
   * → mark completed. Fields are filled BEFORE any irreversible click, so a
   * DiscoveryError here is safely retryable after the selector is fixed.
   */
  async completeWorkOrder(workOrderUrl: string, args: CompleteWorkOrderArgs): Promise<void> {
    const page = await this.open(workOrderUrl, 'wo-complete');
    if (await this.statusVisible(page, /WAITING\s*FOR\s*QC|\bCOMPLETED\b/i)) return;

    const edited = await this.clickControlIfPresent(page, /^edit$/i);
    if (edited) await page.waitForTimeout(2200);

    const durOk = await this.fillFields(page, /duration|durasi|waktu|time[_\s-]*spent|minutes/i, String(args.waktuMinutes), { all: false });
    const fbCount = args.feedback
      ? await this.fillFields(page, /feedback/i, args.feedback, { all: true })
      : 0;
    if (!durOk && args.feedback && fbCount === 0) {
      throw new DiscoveryError(
        `Selesai WO: field duration/waktu dan feedback tidak ditemukan. Field terlihat: ${await this.fieldList(page)}`,
      );
    }

    const saved = await this.clickControlIfPresent(page, /^(save|simpan|update)$/i);
    if (saved) {
      await page.waitForTimeout(1500);
      await this.confirmModals(page);
      await page.waitForTimeout(2500);
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    // Completing a Work Order is PER SERVICE LINE, not a toolbar button: each
    // line carries a Rails PATCH link in its Progress column
    // (/service_work_orders/<id>/start_progress_service_item?additional_line_id=…)
    // which, once started, is replaced by the finish link. Only when every line
    // is done does the order move to WAITING FOR QC. The old code hunted for a
    // "Mark Completed" control that this build simply does not have.
    const PROGRESS_LINK = 'a[href*="progress_service_item"]';
    for (let i = 0; i < 12; i++) {
      const link = page.locator(PROGRESS_LINK).first();
      if ((await link.count().catch(() => 0)) === 0) break;
      const href = (await link.getAttribute('href').catch(() => null)) ?? '(?)';
      await link.click({ timeout: 6000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1200);
      await this.confirmModals(page);
      await page.waitForTimeout(800);
      if (await this.statusVisible(page, /WAITING\s*FOR\s*QC|\bCOMPLETED\b/i)) break;
      // A link that survives its own click would loop forever.
      const still = await page.locator(`a[href="${href}"]`).count().catch(() => 0);
      if (still > 0 && i > 6) break;
    }
    // Some tenants still expose a toolbar control; harmless when absent.
    await this.clickControlIfPresent(page, /mark\s*(as\s*)?complete[d]?|^complete[d]?$|^finish$|^selesai$/i);
    await page.waitForTimeout(1200);
    await this.confirmModals(page);
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-wo-completed');
    await this.verifyStatus(page, /WAITING\s*FOR\s*QC|\bCOMPLETED\b/i, 'Selesai Work Order');
    await this.session.noteJobDone();
  }

  /**
   * QC: fill Next Service Recommendations (NEXT ODOMETER / NEXT SERVICE DATE /
   * RECOMMENDATIONS), approve the service part(s), save → verify COMPLETED.
   */
  async qcApprove(workOrderUrl: string, args: QcApproveArgs): Promise<void> {
    const page = await this.open(workOrderUrl, 'wo-qc');
    if (await this.statusVisible(page, /\bCOMPLETED\b/i)) return;

    const edited = await this.clickControlIfPresent(page, /^edit$/i);
    if (edited) await page.waitForTimeout(2200);

    const misses: string[] = [];
    if (args.nextOdometer != null) {
      const ok = await this.fillFields(page, /next[_\s-]*odometer|odometer[_\s-]*next|next[_\s-]*km|km[_\s-]*next/i, String(args.nextOdometer), { all: false });
      if (!ok) misses.push('NEXT ODOMETER');
    }
    if (args.nextServiceDateISO) {
      const ok = await this.fillFields(page, /next[_\s-]*service[_\s-]*date|next[_\s-]*date/i, args.nextServiceDateISO, { all: false });
      if (!ok) misses.push('NEXT SERVICE DATE');
    }
    if (args.recommendations) {
      const ok = await this.fillFields(page, /recommendation|rekomendasi/i, args.recommendations, { all: false });
      if (!ok) misses.push('RECOMMENDATIONS');
    }
    if (misses.length) {
      throw new DiscoveryError(
        `QC: field ${misses.join(', ')} tidak ditemukan di halaman WO. Field terlihat: ${await this.fieldList(page)}`,
      );
    }

    // Approve at the service part(s) — per-line approve controls when present.
    const perLine = await this.clickAllControls(page, /^approve[d]?$|^pass$|^qc\s*ok$/i);
    if (perLine === 0) {
      await this.clickControl(page, /qc|approve/i, 'tombol Approve/QC di Work Order');
    }
    await page.waitForTimeout(1200);
    await this.confirmModals(page);

    const saved = await this.clickControlIfPresent(page, /^(save|simpan|update)$/i);
    if (saved) {
      await page.waitForTimeout(1500);
      await this.confirmModals(page);
    }
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-wo-qc');
    await this.verifyStatus(page, /\bCOMPLETED\b/i, 'QC Work Order');
    await this.session.noteJobDone();
  }

  /** Create the Service Invoice (SRI/…) from a COMPLETED Work Order. */
  async createInvoice(workOrderUrl: string): Promise<CreateInvoiceResult> {
    const page = await this.open(workOrderUrl, 'invoice-create');
    // Idempotency read-back BEFORE the irreversible click (see createWorkOrder).
    const already = await this.findLinkedDocOnPage(page, /(service_invoices|invoices)\/\d+/, /^SRI\//);
    if (already) {
      await this.session.noteJobDone();
      return { invoiceNo: already.no, invoiceUrl: already.url };
    }
    await this.clickControl(
      page,
      /create\s*(service\s*)?invoice|buat\s*invoice|\+\s*invoice/i,
      'tombol Create Invoice di Work Order (harus COMPLETED dulu)',
    );
    await page.waitForTimeout(1500);
    await this.confirmModals(page);
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Landed on an invoice FORM (…/new)? Save it to get the document.
    if (/\/new\b/.test(page.url())) {
      const saved = await this.clickControlIfPresent(page, /^(save|simpan|create)$/i);
      if (saved) {
        await page.waitForTimeout(1500);
        await this.confirmModals(page);
        await page.waitForTimeout(3000);
        await page.waitForLoadState('networkidle').catch(() => {});
      }
    }
    await this.snapshot(page, 'flow-invoice-created');

    const inline = await this.readInlineError(page);
    if (inline) throw new DataError(`Create Invoice ditolak Turboly: ${inline}`);
    if (!/(service_invoices|invoices)\/\d+/.test(page.url())) {
      throw new DiscoveryError(
        `Invoice tidak terbentuk — setelah klik create URL masih ${page.url()}. ` +
          `Tombol terlihat: ${await this.buttonList(page)}`,
      );
    }
    const invoiceNo = await this.captureDocNo(page, /^SRI\//);
    await this.session.noteJobDone();
    return { invoiceNo, invoiceUrl: page.url() };
  }

  /**
   * Recovery probe: the SWO already linked on a Service Order page, or null.
   * Used by the worker when flow state says a WO exists but its URL was lost
   * (e.g. state derived from a mirrored doc number) — never re-creates.
   */
  async findLinkedWorkOrder(serviceOrderUrl: string): Promise<CreateWorkOrderResult | null> {
    const page = await this.open(serviceOrderUrl, 'wo-linked-probe');
    const hit = await this.findLinkedDocOnPage(page, /service_work_orders\/\d+/, /^SWO\//);
    return hit ? { workOrderNo: hit.no, workOrderUrl: hit.url } : null;
  }

  /** Recovery probe: the SRI already linked on a Work Order page, or null. */
  async findLinkedInvoice(workOrderUrl: string): Promise<CreateInvoiceResult | null> {
    const page = await this.open(workOrderUrl, 'invoice-linked-probe');
    const hit = await this.findLinkedDocOnPage(page, /(service_invoices|invoices)\/\d+/, /^SRI\//);
    return hit ? { invoiceNo: hit.no, invoiceUrl: hit.url } : null;
  }

  /** Payments tab: add payment (method + amount) → complete → verify COMPLETED. */
  async completeInvoice(invoiceUrl: string, args: CompleteInvoiceArgs): Promise<void> {
    const page = await this.open(invoiceUrl, 'invoice-complete');
    if (await this.statusVisible(page, /\bCOMPLETED\b/i)) return;

    await this.clickControl(page, /^payments?$|pembayaran/i, 'tab Payments di Invoice');
    await page.waitForTimeout(1500);
    await this.clickControlIfPresent(page, /add\s*payment|new\s*payment|\+\s*payment|tambah\s*pembayaran/i);
    await page.waitForTimeout(1200);

    // Payment method: native select first, then a select2 fallback.
    const methodOk =
      (await this.selectNativeOption(page, /payment|method|metode/i, args.method)) ||
      (await this.tryPickSelect2ByHint(page, /payment|method|metode/i, args.method));
    if (!methodOk) {
      throw new DiscoveryError(
        `Invoice: kontrol payment method tidak ditemukan (dicari "${args.method}"). Kontrol terlihat: ${await this.controlHints(page)}`,
      );
    }
    const amountOk = await this.fillFields(page, /amount|jumlah|nominal/i, String(args.amount), { all: false, last: true });
    if (!amountOk) {
      throw new DiscoveryError(`Invoice: field amount tidak ditemukan. Field terlihat: ${await this.fieldList(page)}`);
    }
    const savedPay = await this.clickControlIfPresent(page, /^(save|simpan|add|submit)$/i);
    if (savedPay) {
      await page.waitForTimeout(1500);
      await this.confirmModals(page);
      await page.waitForTimeout(2000);
    }

    await this.clickControl(page, /^complete[d]?$|^finish$|^selesai(kan)?$/i, 'tombol Complete di Invoice');
    await page.waitForTimeout(1200);
    await this.confirmModals(page);
    await page.waitForTimeout(2500);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-invoice-completed');
    const inline = await this.readInlineError(page);
    if (inline) throw new DataError(`Complete Invoice ditolak Turboly: ${inline}`);
    await this.verifyStatus(page, /\bCOMPLETED\b/i, 'Selesaikan Invoice');
    await this.session.noteJobDone();
  }

  /**
   * SO edit → Inspections tab → Add Category / Add Inspection rows.
   * Check & Go default: one category row "Check and Go"; detailed items get
   * description + feedback (pass/fail) + recommendation.
   */
  async fillInspections(serviceOrderUrl: string, items: InspectionItemInput[]): Promise<void> {
    if (!items.length) return;
    const page = await this.open(serviceOrderUrl, 'so-inspections');

    // Get into edit mode (button first; /edit URL as fallback).
    const edited = await this.clickControlIfPresent(page, /^edit$/i);
    if (edited) {
      await page.waitForTimeout(2200);
    } else {
      const m = /(\/service_orders\/\d+)/.exec(serviceOrderUrl);
      if (m?.[1]) {
        await page.goto(`${this.abs(m[1])}/edit`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);
      }
    }

    // Inspections tab — selmap locator first, generic text find second.
    let tabOk = false;
    if (await exists(page, S.tabs.inspections, 2500)) {
      tabOk = await resolve(page, S.tabs.inspections)
        .first()
        .click({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!tabOk) await this.clickControl(page, /inspections?|inspeksi/i, 'tab Inspections di Service Order');
    await page.waitForTimeout(1200);

    const misses: string[] = [];
    for (const item of items) {
      const added =
        (await this.clickControlIfPresent(page, /add\s*category|tambah\s*kategori/i)) ||
        (await this.clickControlIfPresent(page, /add\s*inspection|tambah\s*inspeksi/i));
      if (!added) {
        throw new DiscoveryError(
          `Inspections: tombol Add Category/Add Inspection tidak ditemukan. Tombol terlihat: ${await this.buttonList(page)}`,
        );
      }
      await page.waitForTimeout(900);
      if (item.category && !(await this.fillFields(page, /category|kategori/i, item.category, { all: false, last: true }))) {
        misses.push(`category "${item.category}"`);
      }
      if (item.description && !(await this.fillFields(page, /description|deskripsi|inspection[_\s-]*name/i, item.description, { all: false, last: true }))) {
        misses.push(`description "${item.description}"`);
      }
      if (item.feedback) {
        const fb =
          (await this.selectNativeOption(page, /feedback/i, item.feedback, { last: true })) ||
          (await this.fillFields(page, /feedback/i, item.feedback, { all: false, last: true }));
        if (!fb) misses.push(`feedback "${item.feedback}"`);
      }
      if (item.recommendation && !(await this.fillFields(page, /recommendation|rekomendasi/i, item.recommendation, { all: false, last: true }))) {
        misses.push(`recommendation "${item.recommendation}"`);
      }
    }
    if (misses.length) {
      // Nothing irreversible has happened yet (no save) — loud, retry-safe.
      throw new DiscoveryError(
        `Inspections: field tidak ditemukan untuk ${misses.join('; ')}. Field terlihat: ${await this.fieldList(page)}`,
      );
    }

    await this.clickControl(page, /^(save|simpan)$/i, 'tombol Save Service Order (Inspections)');
    await page.waitForTimeout(1500);
    await this.confirmModals(page);
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-so-inspections');
    const inline = await this.readInlineError(page);
    if (inline) throw new DataError(`Simpan Inspections ditolak Turboly: ${inline}`);
    await this.session.noteJobDone();
  }

  // ── customer registration ────────────────────────────────────────────────

  /**
   * Customers → Retail Customers → New. Mandatory starred fields + full
   * address in the bottom address field, Service Tax PPN / "Always use Tax".
   * `companyName` links the retail customer to a wholesale company (corporate).
   */
  /** The customer form's address block lives in a collapsed section/tab —
   * reveal it before filling (fill() requires a visible element). */
  private async revealAddressSection(page: Page): Promise<void> {
    const visible = await page
      .evaluate(() => {
        const el = document.querySelector('#address_address');
        const r = el?.getBoundingClientRect();
        return !!(r && r.width > 0 && r.height > 0);
      })
      .catch(() => false);
    if (visible) return;
    // "Add Address" opens the address modal; Turboly then requires exactly one
    // MAIN address ("Main Address must be one").
    await page.evaluate(() => {
      const hit = Array.from(document.querySelectorAll('a, button')).find((n) =>
        /add\s*address/i.test((n as HTMLElement).innerText ?? '') && (n as HTMLElement).offsetParent !== null,
      );
      (hit as HTMLElement | undefined)?.click();
    });
    await page.waitForTimeout(1500);
  }

  /**
   * Close the address modal and mark the row as the MAIN address.
   *
   * Turboly's "Add Address" does two things at once: it appends a
   * `tr.nested-fields` row to `tbody#list-address` (all values in hidden
   * `customer[addresses_attributes][…]` inputs) and opens a modal holding the
   * visible fields. The modal's own Save copies modal → row. The main-address
   * pick is a RADIO in that row (`name=main_address_index`), NOT a checkbox —
   * getting that wrong is what produced "Main Address must be one".
   */
  private async finishAddressSection(page: Page): Promise<void> {
    // 1. Confirm the ADDRESS modal (its Save, never the page's Save Customer).
    await page.evaluate(`(() => {
      const open = Array.from(document.querySelectorAll('.modal, .modal-scrollable')).filter((m) => getComputedStyle(m).display !== 'none');
      const modal = open.find((m) => /address\\s*type|\\bcountry\\b/i.test(m.innerText || '')) || open[open.length - 1];
      if (!modal) return false;
      const btn = Array.from(modal.querySelectorAll('a, button, input[type=button], input[type=submit]')).find((n) => /^(save|simpan|ok|add|tambah)$/i.test(((n.innerText || n.value) || '').trim()));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await page.waitForTimeout(1600);

    // 2. Exactly ONE main address — the row radio (fallback: a labelled checkbox).
    const marked = (await page.evaluate(`(() => {
      const radios = Array.from(document.querySelectorAll('input[type=radio]')).filter((r) => /main_address/i.test(r.name || r.id || ''));
      const free = radios.find((r) => !r.disabled);
      if (free) { if (!free.checked) free.click(); return radios.some((r) => r.checked); }
      const box = Array.from(document.querySelectorAll('input[type=checkbox]')).find((c) => {
        const lab = ((document.querySelector('label[for="' + c.id + '"]') || {}).textContent || (c.closest('label') || {}).textContent || '');
        return /main\\s*address|alamat\\s*utama|primary/i.test(lab + ' ' + (c.id || c.name || ''));
      });
      if (box) { if (!box.checked) box.click(); return box.checked; }
      return false;
    })()`)) as boolean;
    if (!marked) {
      throw new DiscoveryError(
        'Alamat: kontrol "Main Address" tidak ditemukan setelah Add Address — Turboly akan menolak dengan "Main Address must be one"',
      );
    }
    await page.waitForTimeout(600);
  }

  /**
   * "* SALES TAX" = PPN, read back to prove it stuck.
   *
   * Two traps here. The field has a DIFFERENT id on each form —
   * #customer_service_tax_id on retail, #customer_tax_id on wholesale (and
   * #customer_tax_no next to it is NPWP, not this) — so the retail id alone
   * silently matched nothing on a company. And it is a select2 over a hidden
   * native <select>, which Playwright's selectOption cannot act on; the old
   * call swallowed that too. Setting `.value` isn't enough either: select2
   * only notices a jQuery `change`. Loud on failure — nothing is saved yet at
   * this point, so a throw here is retry-safe.
   */
  private async setSalesTaxPPN(page: Page, what: string): Promise<void> {
    const set = (await page.evaluate(`(() => {
      const sels = ['#customer_service_tax_id', '#customer_tax_id']
        .map((s) => document.querySelector(s))
        .filter(Boolean);
      const sel = sels.find((s) => Array.from(s.options).some((o) => /^ppn$/i.test((o.textContent || '').trim()))) || sels[0];
      if (!sel) return { ok: false, why: 'kontrol tidak ada', options: [] };
      const options = Array.from(sel.options).map((o) => (o.textContent || '').trim());
      const want = Array.from(sel.options).find((o) => /^ppn$/i.test((o.textContent || '').trim()));
      if (!want) return { ok: false, why: 'PPN tidak ada di daftar', options };
      sel.value = want.value;
      // Native + jQuery: Turboly's select2 listens on the jQuery event only.
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      // select2's own change handler can throw on a form whose tax data hasn't
      // loaded yet — cosmetic. The native <select> is the posted field, so a
      // failed widget sync must not abort the fill.
      try { if (window.jQuery) window.jQuery(sel).val(want.value).trigger('change'); } catch (e) { /* widget only */ }
      const now = sel.options[sel.selectedIndex];
      return { ok: /^ppn$/i.test(((now && now.textContent) || '').trim()), why: 'read-back', options };
    })()`)) as { ok: boolean; why: string; options: string[] };
    if (!set.ok) {
      throw new DataError(`${what}: SALES TAX tidak bisa diset ke PPN (${set.why}). Pilihan: ${set.options.join(', ') || '(kosong)'}`);
    }
  }

  /**
   * Credentials for the HTTP path — deliberately the SAME account the browser
   * session logs in with. One session per user means a second account would be
   * a second session; the per-branch encrypted credential is resolved by the
   * session itself (same reach-into-cfg shape as `baseUrl` above), with the env
   * pair as the fallback, so there is exactly one source of truth.
   */
  private async httpConfig(): Promise<HttpRegisterConfig | null> {
    const resolve = (
      this.session as unknown as {
        resolveCredentials?: () => Promise<{ username: string; password: string } | null>;
      }
    ).resolveCredentials;
    const cred = resolve ? await resolve.call(this.session).catch(() => null) : null;
    const username = cred?.username ?? process.env.TURBOLY_USERNAME ?? '';
    const password = cred?.password ?? process.env.TURBOLY_PASSWORD ?? '';
    if (!username || !password) return null;
    return { baseUrl: this.baseUrl, username, password };
  }

  /**
   * Run the HTTP registration, or say why the browser has to. Null means "run
   * the slow path"; a throw means the browser would not have helped (see
   * shouldFallBackToBrowser). Every reason is pushed onto `notes` so the
   * operator reading the job can tell WHICH path registered their customer.
   */
  private async tryHttpRegister(
    run: (cfg: HttpRegisterConfig) => Promise<HttpRegisterResult>,
    notes: string[],
  ): Promise<HttpRegisterResult | null> {
    if (!httpRegisterEnabled()) {
      notes.push('jalur cepat (HTTP) dimatikan lewat TURBOLY_HTTP_REGISTER — dipakai robot browser');
      return null;
    }
    const cfg = await this.httpConfig();
    if (!cfg) {
      notes.push('kredensial Turboly untuk jalur cepat (HTTP) tidak tersedia — dipakai robot browser');
      return null;
    }
    try {
      return await run(cfg);
    } catch (err) {
      if (!shouldFallBackToBrowser(err)) throw err;
      const why = err instanceof Error ? err.message : String(err);
      notes.push(`jalur cepat (HTTP) tidak bisa membaca form Turboly (${why}) — dilanjutkan robot browser`);
      return null;
    }
  }

  async registerRetailCustomer(args: RegisterRetailArgs): Promise<RegisterCustomerResult> {
    // Store the LOCAL 0… spelling like the rest of Turboly does: its customer
    // search is a prefix match on the stored string, so a "+62…" record and a
    // "0…" record never find each other — the web form's E.164 made the SO push
    // miss this customer and create a second, company-less duplicate.
    const phone = localPhone(args.phone);
    // Dedupe by phone BEFORE registering: a retried job may have already saved
    // this customer (save click landed, then the session died before read-back).
    const dup = await this.findExistingCustomerByPhone(phone);
    if (dup) return dup;

    const notes: string[] = [];
    const fast = await this.tryHttpRegister(
      (cfg) =>
        registerRetailHttp(cfg, {
          nama: args.nama,
          phone,
          alamat: args.alamat,
          storeTurbolyId: args.storeTurbolyId ?? null,
          companyName: args.companyName ?? null,
          companyId: args.companyId ?? null,
        }),
      notes,
    );
    if (fast) {
      return { customerId: fast.customerId, customerUrl: fast.customerUrl, note: 'didaftarkan lewat jalur cepat (HTTP)' };
    }
    // An unclassified HTTP failure can also be a socket that died AFTER the POST
    // was sent, which looks identical to one that died before. Re-run the same
    // guard rather than trust that: the browser attempt below would otherwise
    // create the second customer this guard exists to prevent.
    const late = await this.findExistingCustomerByPhone(phone);
    if (late) return { ...late, note: [late.note, ...notes].filter(Boolean).join(' • ') };

    const page = await this.openFormPage(
      ['/customers/new'],
      '/customers',
      /new\s*(retail\s*)?customer|add\s*(retail\s*)?customer|\+\s*new/i,
      'form Retail Customer baru',
    );

    await this.fillSelectorOrPattern(page, '#customer_name', /customer.*name|^name$|nama/i, args.nama, 'nama customer');
    await this.fillSelectorOrPattern(page, '#customer_phone', /phone|telepon|hp/i, phone, 'nomor HP');
    // Turboly requires a customer group name mirroring the customer name.
    await page.fill('#customer_group_name', args.nama).catch(() => {});
    // Full address goes in the BOTTOM address field (no area/region granularity).
    await this.revealAddressSection(page);
    await this.fillSelectorOrPattern(
      page,
      '#address_address',
      /^address$|alamat/i,
      args.alamat,
      'alamat',
      { last: true },
    );
    await this.finishAddressSection(page);

    if (args.storeTurbolyId) {
      const storeOk =
        (await page
          .selectOption('#customer_store_id', { value: args.storeTurbolyId })
          .then(() => true)
          .catch(() => false)) || (await this.selectNativeOption(page, /store|location|cabang/i, args.storeTurbolyId));
      if (!storeOk) {
        throw new DiscoveryError(
          `Customer Retail: kontrol Store tidak ditemukan (store id ${args.storeTurbolyId}). Kontrol terlihat: ${await this.controlHints(page)}`,
        );
      }
    }

    await this.setSalesTaxPPN(page, 'Customer Retail');

    if (args.companyName) {
      const companyOk =
        (await page.selectOption('#customer_customer_wholesale_id', { label: args.companyName }).then(() => true).catch(() => false)) ||
        (await this.tryPickSelect2ByHint(page, /wholesale|company|perusahaan/i, args.companyName)) ||
        (await this.selectNativeOption(page, /wholesale|company|perusahaan/i, args.companyName));
      if (!companyOk) {
        throw new DiscoveryError(
          `Customer Retail: kontrol Company (link ke wholesale "${args.companyName}") tidak ditemukan. Kontrol terlihat: ${await this.controlHints(page)}`,
        );
      }
    }

    await this.snapshot(page, 'flow-cust-retail-presave');
    await this.clickControl(page, /^(save|simpan|create|submit)$/i, 'tombol Save Customer Retail');
    await page.waitForTimeout(1500);
    await this.confirmModals(page);
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-cust-retail-saved');

    const saved = await this.readCustomerSaveResult(page, /(retail_customers|customers)\/(\d+)/, 'Customer Retail');
    notes.push('didaftarkan lewat robot browser');
    return { ...saved, note: [saved.note, ...notes].filter(Boolean).join(' • ') };
  }

  /**
   * Corporate: create the WHOLESALE company FIRST (name, PIC, NPWP, address,
   * Currency IDR, PPN, sales advisor), then the linked retail customer.
   */
  async registerWholesaleCustomer(args: RegisterWholesaleArgs): Promise<RegisterWholesaleResult> {
    // Dedupe by company name BEFORE registering: the company save is the
    // irreversible first half of the corporate flow — when a retry re-runs
    // after a mid-retail failure, the company must NOT be created twice.
    const dupCo = await this.findExistingCompanyByName(args.companyName);
    if (dupCo) {
      return this.withLinkedRetail(args, {
        companyId: dupCo.customerId,
        companyUrl: dupCo.customerUrl,
        existing: true,
        note: `perusahaan "${args.companyName}" sudah terdaftar — tidak dibuat ulang (guard duplikat)`,
      });
    }

    const notes: string[] = [];
    const fast = await this.tryHttpRegister(
      (cfg) =>
        registerWholesaleHttp(cfg, {
          companyName: args.companyName,
          picName: args.picName,
          npwp: args.npwp,
          alamat: args.alamat,
          advisorName: args.advisorName,
        }),
      notes,
    );
    if (fast) {
      return this.withLinkedRetail(args, {
        companyId: fast.customerId,
        companyUrl: fast.customerUrl,
        note: 'perusahaan didaftarkan lewat jalur cepat (HTTP)',
      });
    }
    // Same reasoning as the retail path: an unclassified HTTP failure may have
    // POSTed. Re-probe before letting the browser create a second company.
    const lateCo = await this.findExistingCompanyByName(args.companyName);
    if (lateCo) {
      return this.withLinkedRetail(args, {
        companyId: lateCo.customerId,
        companyUrl: lateCo.customerUrl,
        existing: true,
        note: [`perusahaan "${args.companyName}" ternyata sudah tersimpan — tidak dibuat ulang`, ...notes].join(' • '),
      });
    }

    const page = await this.openFormPage(
      ['/customers/new?wholesale=1'],
      '/customers/wholesale',
      /new\s*(wholesale\s*)?customer|add\s*(wholesale\s*)?customer|\+\s*new/i,
      'form Wholesale Customer baru',
    );

    await this.fillSelectorOrPattern(page, '#customer_name', /company.*name|customer.*name|^name$|nama/i, args.companyName, 'nama perusahaan');
    await page.fill('#customer_group_name', args.companyName).catch(() => {});
    // PIC = "Contact Fullname"; NPWP = tax_no on this form.
    await this.fillSelectorOrPattern(page, '#customer_contact_fullname', /contact.*(full)?name|pic|person[_\s-]*in[_\s-]*charge/i, args.picName, 'PIC (Contact Fullname)');
    await this.fillSelectorOrPattern(page, '#customer_tax_no', /npwp|tax[_\s-]*(no|number|id)/i, args.npwp, 'NPWP');
    await this.revealAddressSection(page);
    await this.fillSelectorOrPattern(page, '#address_address', /^address$|alamat/i, args.alamat, 'alamat', { last: true });
    await this.finishAddressSection(page);

    await this.selectNativeOption(page, /currency|mata\s*uang/i, 'IDR');
    await this.setSalesTaxPPN(page, 'Customer Wholesale');
    // "* Salesperson" (select#salesperson-id) is REQUIRED on this form. Match the
    // requested name exactly; if it isn't in the list, fail with the real options
    // instead of silently crediting the wrong person.
    const salesOk = args.advisorName
      ? await page.selectOption('#salesperson-id', { label: args.advisorName }).then(() => true).catch(() => false)
      : false;
    if (!salesOk) {
      const opts = await page
        .$$eval('#salesperson-id option', (os) => os.map((o) => (o.textContent ?? '').trim()).filter(Boolean).slice(0, 12))
        .catch(() => [] as string[]);
      throw new DataError(
        `Customer Wholesale: Salesperson "${args.advisorName || '(kosong)'}" tidak ada di daftar Turboly. Pilihan: ${opts.join(', ') || '(kosong)'}`,
      );
    }

    await this.snapshot(page, 'flow-cust-wholesale-presave');
    await this.clickControl(page, /^(save|simpan|create|submit)$/i, 'tombol Save Customer Wholesale');
    await page.waitForTimeout(1500);
    await this.confirmModals(page);
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, 'flow-cust-wholesale-saved');

    const company = await this.readCustomerSaveResult(page, /(wholesale_customers|companies|customers)\/(\d+)/, 'Customer Wholesale');
    notes.push('perusahaan didaftarkan lewat robot browser');
    return this.withLinkedRetail(args, {
      companyId: company.customerId,
      companyUrl: company.customerUrl,
      note: notes.join(' • '),
    });
  }

  /**
   * Corporate order, in one place: the company exists by the time this runs,
   * and only then is the linked retail customer registered. It carries the
   * company's id so it links to THIS company rather than a same-named one, and
   * the name too because the browser path can only pick by visible text. A
   * failure in the retail half leaves the company created on purpose — the name
   * guard at the top of registerWholesaleCustomer is what stops the retry from
   * making a second one.
   */
  private async withLinkedRetail(
    args: RegisterWholesaleArgs,
    company: RegisterWholesaleResult,
  ): Promise<RegisterWholesaleResult> {
    if (!args.retail) return company;
    return {
      ...company,
      retail: await this.registerRetailCustomer({
        ...args.retail,
        companyName: args.companyName,
        companyId: company.companyId,
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Discovery-friendly primitives
  // ─────────────────────────────────────────────────────────────────────────

  /** ensureLoggedIn + goto + settle + clear stray warning modals. */
  private async open(url: string, tag: string): Promise<Page> {
    await this.session.ensureLoggedIn();
    const page = this.session.page_();
    const target = this.abs(url);
    // Turboly bounces the FIRST navigation after a (re)login to /dashboard, and
    // serves a maintenance page during upgrades. Verify we actually landed on
    // the requested document and retry — otherwise every verb "fails" with a
    // confusing button list scraped from the dashboard.
    const wantPath = new URL(target).pathname;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await page.goto(target, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const here = new URL(page.url()).pathname;
      // null (not '') when the read itself failed — a failed read is not
      // evidence of a blank page, and isVendorOutagePage relies on the two
      // being distinguishable.
      const body = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => null)) as string | null;
      if (/site maintenance|undergoing scheduled upgrades/i.test(body ?? '')) {
        throw new TransientError('Turboly sedang MAINTENANCE (upgrade terjadwal) — dilanjutkan otomatis setelah online lagi');
      }
      const status = res?.status() ?? 0;
      if (isVendorOutagePage(status, body, await page.title().catch(() => ''))) {
        throw new TransientError(
          `Turboly sedang bermasalah (gangguan vendor${status >= 400 ? `, HTTP ${status}` : ''}) — dicoba ulang otomatis`,
        );
      }
      if (here === wantPath) break;
      if (attempt === 3) {
        throw new TransientError(
          `navigasi ke ${wantPath} dialihkan ke ${here} (3×) — kemungkinan sesi Turboly ter-kick; dicoba ulang otomatis`,
        );
      }
      await this.session.ensureLoggedIn();
      await page.waitForTimeout(1200);
    }
    await this.dismissModals(page);
    await this.snapshot(page, `flow-${tag}-open`);
    return page;
  }

  private abs(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /**
   * Direct-URL first, list+button second: navigate to the first candidate path
   * that renders a real form (a visible text input), else open the list page
   * and click the "new" control. Loud when neither works.
   */
  private async openFormPage(newPaths: string[], listPath: string, newButton: RegExp, what: string): Promise<Page> {
    for (const p of newPaths) {
      // open() VERIFIES the landing path. Without that, a kicked session serves
      // /users/sign_in — two visible inputs, so it passed the "looks like a
      // form" check below and we filled and "saved" the LOGIN page.
      const page = await this.open(p, 'form');
      const looksLikeForm = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea'));
        const visible = inputs.filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const denied = /sorry you can'?t view|not found|doesn'?t exist/i.test(document.body?.innerText ?? '');
        return visible.length >= 2 && !denied;
      });
      if (looksLikeForm) {
        await this.dismissModals(page);
        return page;
      }
    }
    const list = await this.open(listPath, 'list');
    await this.clickControl(list, newButton, `${what} — tombol New di ${listPath}`);
    await list.waitForTimeout(2500);
    return list;
  }

  /**
   * Read-back guard for irreversible creates: does the page ALREADY link to the
   * created child document (SWO on the SO page, SRI on the WO page)? A retried
   * job checks this BEFORE clicking create — the click may have landed on a
   * previous attempt that died before it could report back.
   */
  private async findLinkedDocOnPage(
    page: Page,
    hrefRe: RegExp,
    noRe: RegExp,
  ): Promise<{ no: string | null; url: string } | null> {
    const hit = await page.evaluate(
      ({ source, flags }) => {
        const re = new RegExp(source, flags);
        const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        const a = anchors.find((x) => re.test(x.getAttribute('href') ?? ''));
        return a ? { href: a.href, text: (a.innerText ?? '').trim().replace(/\s+/g, ' ') } : null;
      },
      { source: hrefRe.source, flags: hrefRe.flags },
    );
    if (!hit) return null;
    // Doc number: prefer the anchor's own text, else the first PREFIX-matching
    // number in the body (never fall back to an arbitrary number — the page's
    // own doc number, e.g. SRO/…, would be wrong).
    const inText = hit.text.match(/\b[A-Z]{2,4}\/[A-Z0-9]{2,6}\/\d{4,}\b/)?.[0] ?? null;
    let no = inText && noRe.test(inText) ? inText : null;
    if (!no) {
      const body = (await page.textContent('body').catch(() => '')) ?? '';
      const all = body.match(/\b[A-Z]{2,4}\/[A-Z0-9]{2,6}\/\d{4,}\b/g) ?? [];
      no = all.find((n) => noRe.test(n)) ?? null;
    }
    return { no, url: hit.href };
  }

  /**
   * Turboly's own select2 JSON endpoint through the logged-in browser context:
   * GET /lookup/customers.json?search_term=… → { customers: [{id,name,phone}] }.
   * Best-effort — null when the endpoint misbehaves (caller proceeds normally).
   */
  private async lookupCustomers(
    page: Page,
    term: string,
  ): Promise<Array<{ id: number; name: string; phone: string | null }> | null> {
    const res = await page.request
      .get(`${this.baseUrl}/lookup/customers.json?search_term=${encodeURIComponent(term)}&page_limit=10&page=1`, {
        headers: { accept: 'application/json' },
      })
      .catch(() => null);
    // FAIL CLOSED. Returning null here means "nobody holds this phone", which
    // authorises a create — so an unanswered lookup became a duplicate customer.
    // Only a genuine 200 with a customers array may say that.
    if (!res) throw new TransientError('cek duplikat customer tidak terjawab (jaringan) — dicoba ulang otomatis');
    // A kicked session answers this JSON endpoint with the sign-in HTML — which
    // parses as "no customers found" and would defeat the duplicate guard,
    // registering the SAME company twice. Treat it as transient, never as empty.
    const ctype = (res.headers()['content-type'] ?? '').toLowerCase();
    if (/\/users\/sign_in/.test(res.url()) || (res.ok() && !ctype.includes('json'))) {
      throw new TransientError('sesi Turboly ter-kick saat cek duplikat customer — dicoba ulang otomatis');
    }
    if (res.status() >= 500) {
      throw new TransientError(`cek duplikat customer dijawab HTTP ${res.status()} oleh Turboly — dicoba ulang otomatis`);
    }
    try {
      if (!res.ok()) throw new TransientError(`cek duplikat customer dijawab HTTP ${res.status()} — dicoba ulang otomatis`);
      const j = (await res.json()) as { customers?: Array<{ id?: unknown; name?: unknown; phone?: unknown }> };
      if (!Array.isArray(j.customers)) throw new TransientError('cek duplikat customer menjawab bukan JSON customers — dicoba ulang otomatis');
      return j.customers
        .filter((c): c is { id: number; name?: unknown; phone?: unknown } => typeof c.id === 'number')
        .map((c) => ({
          id: c.id,
          name: typeof c.name === 'string' ? c.name : '',
          phone: typeof c.phone === 'string' ? c.phone : null,
        }));
    } catch (e) {
      if (e instanceof TransientError) throw e;
      throw new TransientError('cek duplikat customer gagal dibaca — dicoba ulang otomatis');
    }
  }

  /**
   * Dedupe probe: an existing customer with EXACTLY this phone (canonical form),
   * via /lookup/customers.json under every stored spelling (0…, 62…, +62…).
   * Null = not found / lookup unavailable — caller registers normally.
   */
  private async findExistingCustomerByPhone(phone: string): Promise<RegisterCustomerResult | null> {
    const key = canonPhoneKey(phone ?? '');
    if (key.length < 8) return null;
    await this.session.ensureLoggedIn();
    const page = this.session.page_();
    for (const term of [key, `0${key}`, `62${key}`, `+62${key}`]) {
      const found = await this.lookupCustomers(page, term);
      const hit = found?.find((c) => canonPhoneKey(c.phone ?? '') === key);
      if (hit) {
        return {
          customerId: String(hit.id),
          customerUrl: this.abs(`/customers/${hit.id}`),
          existing: true,
          note: `customer dengan nomor HP ini sudah terdaftar (${hit.name || 'tanpa nama'}) — tidak dibuat ulang (guard duplikat)`,
        };
      }
    }
    return null;
  }

  /**
   * Dedupe probe: an existing WHOLESALE company with exactly this name, found by
   * scanning the wholesale-customers list (search param first, plain list next —
   * the just-created company is the newest row). Best-effort: null = proceed.
   */
  private async findExistingCompanyByName(name: string): Promise<RegisterCustomerResult | null> {
    const want = name.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!want) return null;
    await this.session.ensureLoggedIn();
    const page = this.session.page_();
    // Companies live in the SAME /customers/<id> space as retail customers, so
    // the list page has no distinguishing href to scrape (the old scrape looked
    // for /wholesale_customers/<id> links that Turboly never renders — which is
    // why the same company got created twice). Their own select2 endpoint is
    // authoritative; on a duplicate name the LOWEST id is the original.
    const res = await page.request
      .get(`${this.baseUrl}/lookup/wholesale_customers.json?search_term=${encodeURIComponent(name.trim())}&page_limit=20&page=1`, {
        headers: { accept: 'application/json' },
      })
      .catch(() => null);
    // Same rule as the customer probe: the company create is irreversible and
    // this is the only guard in front of it, so silence must never read as "new".
    if (!res) throw new TransientError('cek duplikat perusahaan tidak terjawab (jaringan) — dicoba ulang otomatis');
    if (res.status() >= 500) throw new TransientError(`cek duplikat perusahaan dijawab HTTP ${res.status()} — dicoba ulang otomatis`);
    const ctype = (res.headers()['content-type'] ?? '').toLowerCase();
    if (/\/users\/sign_in/.test(res.url()) || (res.ok() && !ctype.includes('json'))) {
      throw new TransientError('sesi Turboly ter-kick saat cek duplikat perusahaan — dicoba ulang otomatis');
    }
    if (!res.ok()) throw new TransientError(`cek duplikat perusahaan dijawab HTTP ${res.status()} — dicoba ulang otomatis`);
    const j = (await res.json().catch(() => null)) as { customers?: Array<{ id?: unknown; name?: unknown }> } | null;
    if (!j || !Array.isArray(j.customers)) {
      throw new TransientError('cek duplikat perusahaan menjawab bukan JSON — dicoba ulang otomatis');
    }
    const hits = (j?.customers ?? [])
      .filter((c) => typeof c.id === 'number' && String(c.name ?? '').trim().toUpperCase().replace(/\s+/g, ' ') === want)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const hit = hits[0];
    if (!hit) return null;
    return {
      customerId: String(hit.id),
      customerUrl: this.abs(`/customers/${hit.id}`),
      existing: true,
      note:
        hits.length > 1
          ? `perusahaan "${name.trim()}" ada ${hits.length}× di Turboly — dipakai yang paling awal (id ${hit.id})`
          : undefined,
    };
  }

  /** All visible clickable texts — the payload of every DiscoveryError. */
  private async visibleButtons(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], [role="tab"]'));
      const texts = nodes
        .filter((n) => {
          const r = (n as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((n) => (((n as HTMLElement).innerText || (n as HTMLInputElement).value || '') as string).trim().replace(/\s+/g, ' '))
        .filter((t) => t.length > 0 && t.length <= 60);
      return Array.from(new Set(texts)).slice(0, 60);
    });
  }

  private async buttonList(page: Page): Promise<string> {
    const b = await this.visibleButtons(page);
    return b.length ? `[${b.join(' | ')}]` : '[TIDAK ADA tombol terlihat]';
  }

  /** Visible input/textarea identifiers (id/name/placeholder/label). */
  private async visibleFields(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
      const hints = els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (el as HTMLInputElement).type !== 'hidden';
        })
        .map((el) => {
          const label = (el.labels && el.labels[0]?.textContent) || '';
          const ph = (el as HTMLInputElement).placeholder || '';
          return `${el.tagName.toLowerCase()}#${el.id || '-'}[name=${el.getAttribute('name') || '-'}]${ph ? `(ph:${ph})` : ''}${label ? `(label:${label.trim()})` : ''}`;
        });
      return Array.from(new Set(hints)).slice(0, 80);
    });
  }

  private async fieldList(page: Page): Promise<string> {
    const f = await this.visibleFields(page);
    return f.length ? `[${f.join(' | ')}]` : '[TIDAK ADA field terlihat]';
  }

  private async controlHints(page: Page): Promise<string> {
    return `${await this.buttonList(page)} ${await this.fieldList(page)}`;
  }

  /** Click the first visible control whose text matches — LOUD when missing. */
  private async clickControl(page: Page, pattern: RegExp, what: string): Promise<void> {
    const ok = await this.clickControlIfPresent(page, pattern);
    if (!ok) {
      throw new DiscoveryError(
        `${what}: kontrol /${pattern.source}/ tidak ditemukan di ${page.url()}. Tombol terlihat: ${await this.buttonList(page)}`,
      );
    }
  }

  /** Best-effort click by visible text (DOM click bypasses overlay quirks). */
  private async clickControlIfPresent(page: Page, pattern: RegExp): Promise<boolean> {
    return page.evaluate(
      ({ source, flags }) => {
        const re = new RegExp(source, flags);
        const nodes = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], [role="tab"], li a'));
        const hit = nodes.find((n) => {
          const r = (n as HTMLElement).getBoundingClientRect();
          const txt = (((n as HTMLElement).innerText || (n as HTMLInputElement).value || '') as string).trim().replace(/\s+/g, ' ');
          return r.width > 0 && r.height > 0 && re.test(txt);
        });
        if (hit) {
          (hit as HTMLElement).click();
          return true;
        }
        return false;
      },
      { source: pattern.source, flags: pattern.flags },
    );
  }

  /** Click EVERY visible matching control once (per-line approve buttons). */
  private async clickAllControls(page: Page, pattern: RegExp): Promise<number> {
    return page.evaluate(
      ({ source, flags }) => {
        const re = new RegExp(source, flags);
        const nodes = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'));
        let n = 0;
        for (const el of nodes) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const txt = (((el as HTMLElement).innerText || (el as HTMLInputElement).value || '') as string).trim().replace(/\s+/g, ' ');
          if (r.width > 0 && r.height > 0 && re.test(txt)) {
            (el as HTMLElement).click();
            n++;
          }
        }
        return n;
      },
      { source: pattern.source, flags: pattern.flags },
    );
  }

  /**
   * Fill input(s)/textarea(s) whose id/name/placeholder/label matches.
   * Fires input+change and (for datepickers) updates the jQuery widget's
   * internal state so a re-render can't write a stale value back (same fix
   * as rpaSink.setPickerValue). Returns count filled (all:true) / 1 or 0.
   */
  private async fillFields(
    page: Page,
    pattern: RegExp,
    value: string,
    opts: { all: boolean; last?: boolean } = { all: false },
  ): Promise<number> {
    return page.evaluate(
      ({ source, flags, value, all, last }) => {
        const re = new RegExp(source, flags);
        const els = (Array.from(document.querySelectorAll('input, textarea')) as (HTMLInputElement | HTMLTextAreaElement)[]).filter((el) => {
          const t = (el as HTMLInputElement).type;
          if (t === 'hidden' || t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button' || t === 'file') return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const label = (el.labels && el.labels[0]?.textContent) || '';
          const key = `${el.id} ${el.getAttribute('name') ?? ''} ${(el as HTMLInputElement).placeholder ?? ''} ${label}`;
          return re.test(key);
        });
        const targets = all ? els : els.length ? [last ? els[els.length - 1] : els[0]] : [];
        let n = 0;
        for (const el of targets) {
          if (!el) continue;
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            const w = window as unknown as { jQuery?: (e: Element) => { data: (k: string) => unknown; datepicker: (m: string, v: string) => void } };
            const $el = w.jQuery ? w.jQuery(el) : null;
            if ($el && $el.data('datepicker')) $el.datepicker('update', value);
          } catch {
            /* widget API absent — value+change already set */
          }
          n++;
        }
        return n;
      },
      { source: pattern.source, flags: pattern.flags, value, all: opts.all, last: opts.last ?? false },
    );
  }

  /** Specific selector first (proven ids from rpaSink), pattern fallback — LOUD when both miss. */
  private async fillSelectorOrPattern(
    page: Page,
    selector: string,
    pattern: RegExp,
    value: string,
    what: string,
    opts: { last?: boolean } = {},
  ): Promise<void> {
    const direct = await page
      .fill(selector, value, { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (direct) return;
    const n = await this.fillFields(page, pattern, value, { all: false, last: opts.last ?? false });
    if (n === 0) {
      throw new DiscoveryError(
        `Field ${what} tidak ditemukan (dicoba ${selector} lalu /${pattern.source}/). Field terlihat: ${await this.fieldList(page)}`,
      );
    }
  }

  /**
   * Pick an option on a native <select> found by id/name/label hint (or, when
   * no hinted select exists, ANY select that has a matching option). Option
   * matched by exact text, then contains, then exact value. Returns false on miss.
   */
  private async selectNativeOption(
    page: Page,
    hint: RegExp,
    optionText: string,
    opts: { last?: boolean } = {},
  ): Promise<boolean> {
    return page.evaluate(
      ({ source, flags, optionText, last }) => {
        const re = new RegExp(source, flags);
        const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');
        const want = norm(optionText);
        const all = (Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const hinted = all.filter((el) => {
          const label = (el.labels && el.labels[0]?.textContent) || '';
          return re.test(`${el.id} ${el.getAttribute('name') ?? ''} ${label}`);
        });
        const pool = hinted.length ? hinted : all;
        const candidates = last ? [...pool].reverse() : pool;
        for (const sel of candidates) {
          const options = Array.from(sel.options);
          const hit =
            options.find((o) => norm(o.textContent ?? '') === want) ??
            options.find((o) => norm(o.textContent ?? '').includes(want)) ??
            options.find((o) => norm(o.value) === want);
          // Unhinted pool: only accept a select that REALLY has the option.
          if (!hit) continue;
          sel.value = hit.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      },
      { source: hint.source, flags: hint.flags, optionText, last: opts.last ?? false },
    );
  }

  /** Tick a checkbox whose label/name matches (e.g. "Always use Tax"). */
  private async checkBoxByLabel(page: Page, pattern: RegExp): Promise<boolean> {
    return page.evaluate(
      ({ source, flags }) => {
        const re = new RegExp(source, flags);
        const boxes = (Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const hit = boxes.find((el) => {
          const label = (el.labels && el.labels[0]?.textContent) || el.closest('label')?.textContent || '';
          return re.test(`${el.id} ${el.getAttribute('name') ?? ''} ${label}`);
        });
        if (!hit) return false;
        if (!hit.checked) {
          hit.click();
          if (!hit.checked) {
            hit.checked = true;
            hit.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        return true;
      },
      { source: pattern.source, flags: pattern.flags },
    );
  }

  /**
   * Set the Assignee (mechanic) on every service line of the WO. Tries native
   * selects hinted assignee/mechanic/technician, then select2 containers with
   * the same hints. Returns false when NO assignee control was found at all.
   */
  private async trySetAssignees(page: Page, assigneeName: string): Promise<boolean> {
    if (!assigneeName.trim()) return true;
    let any = false;

    // 1) Native selects (option text contains the mechanic name).
    const nativeCount = await page.evaluate(
      ({ name }) => {
        const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');
        const want = norm(name);
        const sels = (Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]).filter((el) => {
          const r = el.getBoundingClientRect();
          const label = (el.labels && el.labels[0]?.textContent) || '';
          return r.width > 0 && r.height > 0 && /assignee|mechanic|technician|mekanik|teknisi|store[_\s-]*user/i.test(`${el.id} ${el.getAttribute('name') ?? ''} ${label}`);
        });
        let n = 0;
        for (const sel of sels) {
          const options = Array.from(sel.options);
          const hit = options.find((o) => norm(o.textContent ?? '') === want) ?? options.find((o) => norm(o.textContent ?? '').includes(want));
          if (hit) {
            sel.value = hit.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            n++;
          }
        }
        return n;
      },
      { name: assigneeName },
    );
    if (nativeCount > 0) any = true;

    // 2) Select2 containers hinted assignee/mechanic — one search+pick each.
    const containers = page.locator(
      '.select2-container[id*="assignee" i], .select2-container[class*="assignee" i], ' +
        '.select2-container[id*="mechanic" i], .select2-container[class*="mechanic" i], ' +
        '.select2-container[id*="technician" i], .select2-container[id*="store-user" i], .select2-container[id*="store_user" i]',
    );
    const cnt = await containers.count();
    for (let i = 0; i < cnt; i++) {
      try {
        await containers.nth(i).locator('.select2-choice, .select2-choices').first().click({ timeout: 4000 });
        await this.dropPick(page, assigneeName);
        await page.waitForTimeout(400);
        any = true;
      } catch {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    return any;
  }

  /** Select2 pick on a container found by id/class hint. False on miss (drop closed). */
  private async tryPickSelect2ByHint(page: Page, hint: RegExp, query: string): Promise<boolean> {
    // Hint sources are alternations — probe each alternative as an attr substring.
    const alts = hint.source.split('|').map((a) => a.replace(/[^a-z0-9_-]/gi, '')).filter(Boolean);
    for (const alt of alts) {
      const loc = page.locator(`.select2-container[id*="${alt}" i], .select2-container[class*="${alt}" i]`);
      if ((await loc.count()) === 0) continue;
      try {
        await loc.first().locator('.select2-choice, .select2-choices').first().click({ timeout: 4000 });
        await this.dropPick(page, query);
        await page.waitForTimeout(400);
        return true;
      } catch {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    return false;
  }

  /**
   * Select2-v3 dropdown: type into the open drop, wait out the remote search,
   * click the first selectable result. (Copied from rpaSink.dropPick — that
   * class's helper is private and rpaSink must not be edited.)
   */
  private async dropPick(page: Page, query: string): Promise<void> {
    // Works for BOTH select2 flavours. A single-select puts its search box in
    // the drop (#select2-drop input); a MULTI-select — which is what the Work
    // Order's Assignee column is — keeps it inside the container and gives the
    // drop no id at all, so typing into '#select2-drop input' typed into
    // nothing, the search never ran, no assignee was set, and Turboly rejected
    // the Work Order with "Assignee can't be blank". Typing at the keyboard
    // instead lands wherever select2 just focused, whichever flavour it is.
    await page.waitForTimeout(300);
    let ready = false;
    for (let round = 0; round < 2 && !ready; round++) {
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Meta+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(120);
      // select2-v3 re-queries on KEY events only — fill() would search nothing.
      await page.keyboard.type(query, { delay: 25 });
      let empties = 0;
      for (let i = 0; i < 30; i++) {
        const st = await page.evaluate(`(() => {
          var drops = Array.prototype.slice.call(document.querySelectorAll('#select2-drop, .select2-drop'))
            .filter(function (d) { var r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          var li = [];
          for (var d of drops) li = li.concat(Array.prototype.slice.call(d.querySelectorAll('.select2-results li')));
          return {
            sel: li.filter(function (x) { return !/select2-(no-results|searching|selection-limit|disabled|more-results)/.test(x.className); }).length,
            txt: li.map(function (x) { return x.innerText; }).join(' '),
          };
        })()`) as { sel: number; txt: string };
        if (st.sel > 0) {
          ready = true;
          break;
        }
        // "No matches" also renders between queries while the request is still
        // in flight, so it only counts once it has held.
        if (st.txt && !/searching/i.test(st.txt)) {
          if (++empties >= 3) throw new DataError(`tidak ada hasil Turboly untuk "${query}"`);
        } else {
          empties = 0;
        }
        await page.waitForTimeout(700);
      }
    }
    if (!ready) throw new TransientError(`pencarian Turboly "${query}" timeout (masih searching)`);
    await page
      .locator(`#select2-drop .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results), .select2-drop:visible .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results)`)
      .first()
      .click({ timeout: 4000 });
  }

  // ── status / verification ────────────────────────────────────────────────

  /**
   * Workflow status texts that are ACTUALLY ACTIVE on the page.
   *
   * Turboly renders the WHOLE workflow chain (e.g. "WAITING → IN PROGRESS →
   * WAITING FOR QC → COMPLETED") as sibling labels, so FUTURE-stage texts are
   * always somewhere in the DOM — and action-button texts ("Mark Completed")
   * contain stage words too. Matching any of those would make every
   * skip-if-already-done pre-check and every post-action verification pass
   * vacuously. Therefore:
   *   - only leaf-ish, NON-clickable, short-text status/badge/step nodes count;
   *   - when ≥2 such nodes are siblings under one parent/grandparent (i.e. the
   *     rendered workflow chain), only the one marked active/current/selected
   *     counts;
   *   - there is NO body-text fallback, by design.
   * `seen` carries every candidate (inactive chain members included) so a
   * failed verify can report loudly what WAS on the page.
   */
  private async readStatuses(page: Page): Promise<{ active: string[]; seen: string[] }> {
    return page.evaluate(() => {
      const ACTIVE_RE = /(^|[\s_-])(active|current|selected)([\s_-]|$)/i;
      const cls = (el: Element | null): string => (el ? el.getAttribute('class') ?? '' : '');
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // Anything clickable is an ACTION, not a status ("Mark Completed" ≠ COMPLETED).
      const clickable = (el: Element): boolean =>
        el.closest('a, button, [role="button"], [role="tab"], input, select, textarea') !== null;
      const candidates = (
        Array.from(
          document.querySelectorAll(
            '.label, .badge, [class*="status" i], [class*="state" i], ' +
              '[class*="workflow" i] li, [class*="stepper" i] li, [class*="wizard" i] li, .active, .current',
          ),
        ) as HTMLElement[]
      ).filter((el) => {
        if (!visible(el) || clickable(el)) return false;
        const t = (el.innerText ?? '').trim().replace(/\s+/g, ' ');
        return t.length > 0 && t.length <= 40 && el.querySelectorAll('*').length <= 2;
      });
      // Chain detection: candidates sharing a parent (chain of spans/divs) or a
      // grandparent (ul > li > span.label) form the rendered workflow chain.
      const parentCount = new Map<Element, number>();
      const grandCount = new Map<Element, number>();
      for (const el of candidates) {
        const p = el.parentElement;
        const g = p?.parentElement ?? null;
        if (p) parentCount.set(p, (parentCount.get(p) ?? 0) + 1);
        if (g) grandCount.set(g, (grandCount.get(g) ?? 0) + 1);
      }
      const active: string[] = [];
      const seen: string[] = [];
      for (const el of candidates) {
        const t = (el.innerText ?? '').trim().replace(/\s+/g, ' ');
        seen.push(t);
        const p = el.parentElement;
        const g = p?.parentElement ?? null;
        const inChain = (p !== null && (parentCount.get(p) ?? 0) >= 2) || (g !== null && (grandCount.get(g) ?? 0) >= 2);
        const marked = ACTIVE_RE.test(cls(el)) || ACTIVE_RE.test(cls(p)) || ACTIVE_RE.test(cls(g));
        if (!inChain || marked) active.push(t);
      }
      return {
        active: Array.from(new Set(active)).slice(0, 30),
        seen: Array.from(new Set(seen)).slice(0, 30),
      };
    });
  }

  /** Is the expected workflow status the ACTIVE one? Strict — no body fallback. */
  private async statusVisible(page: Page, expected: RegExp): Promise<boolean> {
    const { active } = await this.readStatuses(page);
    return active.some((t) => expected.test(t));
  }

  /** LOUD verify: throws DataError listing active + all candidate statuses seen. */
  private async verifyStatus(page: Page, expected: RegExp, what: string): Promise<void> {
    const { active, seen } = await this.readStatuses(page);
    if (active.some((t) => expected.test(t))) return;
    const inline = await this.readInlineError(page);
    throw new DataError(
      `${what}: status /${expected.source}/ tidak AKTIF di ${page.url()}` +
        `${inline ? ` — error Turboly: ${inline}` : ''} — status aktif: [${active.join(' | ')}]` +
        ` — semua kandidat status: [${seen.join(' | ')}]`,
    );
  }

  /** First doc number matching the preferred prefix (SWO/, SRI/), else the first any. */
  private async captureDocNo(page: Page, prefer: RegExp): Promise<string | null> {
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    const all = body.match(/\b[A-Z]{2,4}\/[A-Z0-9]{2,6}\/\d{4,}\b/g) ?? [];
    return all.find((n) => prefer.test(n)) ?? all[0] ?? null;
  }

  /** Post-save read for customer registration: URL id or a loud DataError. */
  private async readCustomerSaveResult(page: Page, urlRe: RegExp, what: string): Promise<RegisterCustomerResult> {
    const inline = await this.readInlineError(page);
    const m = urlRe.exec(page.url());
    const flashOk = /successfully (create|save)/i.test((await page.textContent('body').catch(() => '')) ?? '');
    // A save that lands on the sign-in page means ANOTHER login kicked us
    // mid-form (Turboly allows one session per user) — nothing was written and
    // nothing is wrong with the data, so this must retry, not page a human.
    if (!m && (/\/users\/sign_in/.test(page.url()) || /you have been logged out|please login again|sign in or sign up/i.test(inline ?? ''))) {
      throw new TransientError(
        `${what}: sesi Turboly ter-kick oleh login lain sebelum simpan — data belum tersimpan, dicoba ulang otomatis`,
      );
    }
    if (!m && !flashOk) {
      throw new DataError(
        `${what}: simpan tidak terkonfirmasi (URL ${page.url()})${inline ? ` — error Turboly: ${inline}` : ''}. ` +
          `Tombol terlihat: ${await this.buttonList(page)}`,
      );
    }
    if (inline && !m) throw new DataError(`${what} ditolak Turboly: ${inline}`);
    return { customerId: m?.[2] ?? null, customerUrl: page.url() };
  }

  // ── modal / error / evidence helpers (rpaSink conventions, copied) ──────

  /** Dismiss any visible warning/info modal by clicking OK/Close/Tutup. */
  private async dismissModals(page: Page): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const clicked = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('.modal-scrollable button, .modal-scrollable a, .modal button, .modal a, [role=dialog] button, [role=dialog] a'));
        const ok = nodes.find((n) => (n as HTMLElement).offsetParent !== null && /^(ok|close|tutup)$/i.test(((n as HTMLElement).textContent ?? '').trim()));
        if (ok) {
          (ok as HTMLElement).click();
          return true;
        }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(600);
    }
  }

  /** Affirm any confirmation modal (Yes/Continue/Save anyway) — opposite of dismiss. */
  private async confirmModals(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const clicked = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('.modal-scrollable button, .modal-scrollable a, .modal button, .modal a, [role=dialog] button, [role=dialog] a'));
        const yes = nodes.find(
          (n) => (n as HTMLElement).offsetParent !== null && /^(ya|yes|ok|save|simpan|lanjut|lanjutkan|continue|confirm|proceed)$/i.test(((n as HTMLElement).textContent ?? '').trim()),
        );
        if (yes) {
          (yes as HTMLElement).click();
          return true;
        }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(1200);
    }
  }

  /** Turboly's Bootstrap-2-era validation banner and friends. */
  private async readInlineError(page: Page): Promise<string | null> {
    for (const sel of ['.alert-error', '.alert-danger', '#error_explanation', '.invalid-feedback', '[role="alert"]', '.text-danger']) {
      const loc = page.locator(sel);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        // Turboly shows tenant-wide banners ("Email is unverified") in the same
        // .alert-error box as validation output. Taking the first hit turned a
        // SUCCESSFUL save into a reported failure — and a failed create is
        // retried, which is how one document becomes two.
        const t = (await loc.nth(i).innerText().catch(() => ''))?.trim().replace(/\s*\n\s*/g, ' • ');
        if (t && !/success/i.test(t) && !/email is unverified|verify your email|mohon melakukan pembayaran/i.test(t)) return t;
      }
    }
    return null;
  }

  /** Evidence screenshot (PUSH_SCREENSHOT_DIR), never fatal. */
  private async snapshot(page: Page, name: string): Promise<string | null> {
    const dir = this.screenshotDir;
    if (!dir) return null;
    const path = `${dir}/${name}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    return path;
  }
}
