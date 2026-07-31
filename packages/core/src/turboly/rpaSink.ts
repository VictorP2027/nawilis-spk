import type { Page } from 'playwright';
import { SELECTOR_MAP as S } from './selmap.js';
import { resolve, selectTypeahead, fillInput, readValue, exists, hashFormControls } from './locators.js';
import { TurbolySession, AuthChallengeError } from './session.js';
import type { ServiceOrderSink, PushContext, PushResult, VerifyResult, TurbolyServiceOrderPayload } from './sink.js';
import type { SpkDoc } from '../types.js';

/**
 * W2 — browser automation against the real Turboly Service Order UI.
 *
 * Safety properties baked in:
 *   - Lease fencing: assertLease() is called before every irreversible click
 *     (Save, Approve). If the lease/epoch is no longer ours, we abort rather
 *     than risk a second worker also saving → duplicate SO.
 *   - One page, serial. The session enforces one context/one page.
 *   - Failure classification: errors are typed so the worker retries correctly.
 *   - Evidence: a screenshot is taken at submit.
 *   - Read-back is a SEPARATE method the worker runs in a fresh context.
 */
export class RpaSink implements ServiceOrderSink {
  readonly mode = 'rpa' as const;

  constructor(
    private readonly session: TurbolySession,
    private readonly opts: { screenshotDir?: string } = {},
  ) {}

  private assertLease(ctx: PushContext): void {
    if (Date.now() >= ctx.leaseExpiresAt) {
      throw new LeaseLostError('Lease expired before irreversible action');
    }
  }

  async pushServiceOrder(payload: TurbolyServiceOrderPayload, ctx: PushContext): Promise<PushResult> {
    let page: Page;
    try {
      await this.session.ensureLoggedIn();
      page = this.session.page_();
    } catch (e) {
      if (e instanceof AuthChallengeError) return fail('auth', e.message);
      return fail('infra', errMsg(e));
    }

    try {
      // 1. Open a fresh New Service Order form.
      await page.goto(S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' });
      await resolve(page, S.routes.newServiceOrderButton).click({ timeout: 10000 });
      await resolve(page, S.tabs.packagesSparepartsServices).waitFor({ state: 'visible', timeout: 10000 });

      // 2. Header — required fields first (the form won't save without them).
      await selectTypeahead(page, S.header.store, payload.storeName);

      // Customer: search existing, else create.
      if (payload.customer.existingQuery) {
        await selectTypeahead(page, S.header.customerSearch, payload.customer.existingQuery);
      } else if (payload.customer.create) {
        await resolve(page, S.header.addNewCustomerButton).click();
        await fillInput(page, S.newCustomer.nama, payload.customer.create.nama);
        await fillInput(page, S.newCustomer.phone, payload.customer.create.phone);
        if (payload.customer.create.alamat) await fillInput(page, S.newCustomer.alamat, payload.customer.create.alamat);
        await resolve(page, S.newCustomer.save).click();
      }

      // Vehicle by registration (typeahead against Turboly's vehicle master).
      await selectTypeahead(page, S.header.vehicleRegistrationSearch, payload.vehicleRegistration);

      await fillInput(page, S.header.odometer, payload.odometer);
      await fillInput(page, S.header.planServiceDate, payload.planServiceDate);
      await fillInput(page, S.header.planServiceTime, payload.planServiceTime);
      await selectTypeahead(page, S.header.serviceAdvisor, payload.serviceAdvisorName);
      await selectTypeahead(page, S.header.salesperson, payload.salespersonName);

      // Reference number = correlation token (the identity we read back on).
      await fillInput(page, S.header.referenceNumber, payload.referenceNumber);
      if (payload.notes) await fillInput(page, S.header.notes, payload.notes);

      // 3. Service lines under the Packages/Spareparts/Services tab.
      await resolve(page, S.tabs.packagesSparepartsServices).click();
      for (const line of payload.serviceLines) {
        await resolve(page, S.services.addServiceItem).click();
        await selectTypeahead(page, S.services.rowService, line.serviceName);
        if (line.description) await fillInput(page, S.services.rowDescription, line.description);
        await fillInput(page, S.services.rowQty, String(line.qty));
        if (line.priceIncTax != null) await fillInput(page, S.services.rowPriceIncTax, String(line.priceIncTax));
        if (line.discount != null) await fillInput(page, S.services.rowDiscount, String(line.discount));
      }
      for (const part of payload.sparepartLines) {
        await resolve(page, S.spareparts.addSparepart).click();
        await selectTypeahead(page, S.spareparts.rowProduct, part.productName);
        await fillInput(page, S.spareparts.rowQty, String(part.qty));
        if (part.priceIncTax != null) await fillInput(page, S.spareparts.rowPriceIncTax, String(part.priceIncTax));
      }

      // 4. Evidence screenshot BEFORE the irreversible save.
      const screenshotRef = await this.snapshot(page, `${payload.spkId}-presave`);

      // 5. Save — the irreversible action. Re-assert the lease immediately before.
      this.assertLease(ctx);
      await resolve(page, S.actions.save).click({ timeout: 15000 });
      await page.waitForLoadState('networkidle').catch(() => {});

      // 6. Capture Turboly's generated document number.
      const serviceOrderNo = await this.captureDocNumber(page);

      // 7. Optionally advance DRAFT → APPROVED.
      if (ctx.approve && (await exists(page, S.actions.approve, 4000))) {
        this.assertLease(ctx);
        await resolve(page, S.actions.approve).click();
        await page.waitForLoadState('networkidle').catch(() => {});
      }

      await this.session.noteJobDone();

      return {
        ok: true,
        serviceOrderNo,
        workOrderNo: null,
        verified: null, // verification is a separate, fresh-context step
        screenshotRef,
      };
    } catch (e) {
      const shot = await this.snapshot(this.session.page_(), `${payload.spkId}-error`).catch(() => null);
      if (e instanceof LeaseLostError) return { ...fail('transient', e.message), screenshotRef: shot };
      if (e instanceof AuthChallengeError) return { ...fail('auth', e.message), screenshotRef: shot };
      // A visible inline validation error means Turboly rejected our DATA
      // (e.g. a newly-required field) — classify as data, not structural, but the
      // worker's cross-branch identical-error detector will escalate to structural
      // if the same message hits many records.
      const dataErr = await this.readInlineError(this.session.page_()).catch(() => null);
      if (dataErr) return { ...fail('data', dataErr), screenshotRef: shot };
      return { ...fail('structural', errMsg(e)), screenshotRef: shot };
    }
  }

  async verifyByToken(doc: SpkDoc): Promise<VerifyResult> {
    // MUST be a fresh navigation — never reuse the write flow's state.
    await this.session.ensureLoggedIn();
    const page = this.session.page_();
    await page.goto(S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' });

    const docNo = doc.turboly.serviceOrderNo;
    if (docNo) {
      await fillInput(page, S.list.documentNumberFilter, docNo);
    } else {
      // Fallback: search by registration; we'll confirm the token on the detail page.
      await fillInput(page, S.list.registrationFilter, doc.vehicle.noPolisi.display);
    }
    await resolve(page, S.list.searchButton).click();
    await page.waitForLoadState('networkidle').catch(() => {});

    const rowLoc = docNo ? S.list.rowByDocNo(docNo) : S.list.rowByRegistration(doc.vehicle.noPolisi.display);
    if (!(await exists(page, rowLoc, 6000))) {
      return { found: false, serviceOrderNo: null, store: null, lineCount: null, lineSkus: [], km: null };
    }
    await resolve(page, rowLoc).first().click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // On the detail page, prove identity: REFERENCE NUMBER == our token.
    const ref = await readValue(page, S.header.referenceNumber);
    const tokenMatches = (ref ?? '').includes(doc.push.correlationToken);
    const store = await readValue(page, S.header.store.trigger);
    const km = await readValue(page, S.header.odometer);
    const savedNo = await this.captureDocNumber(page);

    // Line count/SKUs read from the services table (best-effort text scrape).
    const lineSkus = await page
      .locator('table')
      .last()
      .locator('tbody tr')
      .allTextContents()
      .then((rows) => rows.map((r) => r.trim()).filter(Boolean))
      .catch(() => [] as string[]);

    return {
      found: tokenMatches,
      serviceOrderNo: savedNo ?? docNo,
      store: store,
      lineCount: lineSkus.length || null,
      lineSkus,
      km: km ? Number(km.replace(/[^\d]/g, '')) || null : null,
    };
  }

  async canary(): Promise<{ ok: boolean; controlHash: string; detail?: string }> {
    try {
      await this.session.ensureLoggedIn();
      const page = this.session.page_();
      await page.goto(S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' });
      await resolve(page, S.routes.newServiceOrderButton).click({ timeout: 10000 });
      // Every required control must still resolve.
      const checks: Array<[string, boolean]> = [
        ['store', await exists(page, S.header.store.trigger, 4000)],
        ['customer', await exists(page, S.header.customerSearch.trigger, 4000)],
        ['vehicle', await exists(page, S.header.vehicleRegistrationSearch.trigger, 4000)],
        ['odometer', await exists(page, S.header.odometer, 4000)],
        ['advisor', await exists(page, S.header.serviceAdvisor.trigger, 4000)],
        ['salesperson', await exists(page, S.header.salesperson.trigger, 4000)],
        ['save', await exists(page, S.actions.save, 4000)],
      ];
      const missing = checks.filter(([, ok]) => !ok).map(([n]) => n);
      const controlHash = await hashFormControls(page);
      return { ok: missing.length === 0, controlHash, detail: missing.length ? `missing: ${missing.join(',')}` : undefined };
    } catch (e) {
      return { ok: false, controlHash: '', detail: errMsg(e) };
    }
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async captureDocNumber(page: Page): Promise<string | null> {
    const v = await readValue(page, S.savedDocNumber);
    if (v && /[A-Z]{2,}\/[A-Z0-9]+\/\d+/.test(v)) return v.trim();
    // Fallback: scan the page for the SBO/BRANCH/NNNN pattern.
    const body = await page.textContent('body').catch(() => '');
    const m = /\b([A-Z]{2,4}\/[A-Z0-9]{2,6}\/\d{6,})\b/.exec(body ?? '');
    return m?.[1] ?? v?.trim() ?? null;
  }

  private async readInlineError(page: Page): Promise<string | null> {
    for (const sel of ['.alert-danger', '.invalid-feedback', '[role="alert"]', '.text-danger']) {
      const loc = page.locator(sel);
      if ((await loc.count()) > 0) {
        const t = (await loc.first().textContent().catch(() => ''))?.trim();
        if (t) return t;
      }
    }
    return null;
  }

  private async snapshot(page: Page, name: string): Promise<string | null> {
    if (!this.opts.screenshotDir) return null;
    const path = `${this.opts.screenshotDir}/${name}.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    return path;
  }
}

export class LeaseLostError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LeaseLostError';
  }
}

function fail(failureClass: NonNullable<PushResult['failureClass']>, error: string): PushResult {
  return { ok: false, serviceOrderNo: null, workOrderNo: null, verified: null, failureClass, error };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
