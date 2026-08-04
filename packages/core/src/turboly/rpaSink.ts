import type { Page } from 'playwright';
import { SELECTOR_MAP as S } from './selmap.js';
import { resolve, selectTypeahead, fillInput, readValue, exists, hashFormControls } from './locators.js';
import { TurbolySession, AuthChallengeError } from './session.js';
import type { ServiceOrderSink, PushContext, PushResult, VerifyResult, TurbolyServiceOrderPayload } from './sink.js';
import type { SpkDoc } from '../types.js';
import { jaroWinkler, canonPhoneKey, localPhone } from '../indonesia.js';

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

  /** Extra note lines accumulated during a push (e.g. model-fallback substitutions). */
  private notesExtra: string[] = [];

  async pushServiceOrder(payload: TurbolyServiceOrderPayload, ctx: PushContext): Promise<PushResult> {
    this.notesExtra = [];
    let page: Page;
    try {
      await this.session.ensureLoggedIn();
      page = this.session.page_();
    } catch (e) {
      if (e instanceof AuthChallengeError) return fail('auth', e.message);
      return fail('infra', errMsg(e));
    }

    return this.runPush(payload, ctx, 0);
  }

  /**
   * Build with bounded self-recovery: NeedAddVehicle → create the vehicle then
   * rebuild; NeedCreateMake (operator-confirmed) → create the make (+first model)
   * then rebuild. Each fix navigates away, so the order form is rebuilt fresh.
   */
  private async runPush(payload: TurbolyServiceOrderPayload, ctx: PushContext, depth: number): Promise<PushResult> {
    try {
      return await this.buildAndSaveOrder(payload, ctx);
    } catch (e) {
      if (depth >= 3) return this.classifyFailure(e, payload.spkId);
      if (e instanceof NeedCreateMakeError) {
        try {
          await this.ensureMakeExists(payload.vehicleMake ?? '', payload.vehicleModel ?? '');
        } catch (e2) {
          return this.classifyFailure(e2, payload.spkId);
        }
        return this.runPush(payload, ctx, depth + 1);
      }
      if (e instanceof NeedAddVehicleError) {
        try {
          await this.addVehicleToExistingCustomer(payload);
        } catch (e2) {
          if (e2 instanceof NeedCreateMakeError) {
            try {
              await this.ensureMakeExists(payload.vehicleMake ?? '', payload.vehicleModel ?? '');
              await this.addVehicleToExistingCustomer(payload);
            } catch (e3) {
              return this.classifyFailure(e3, payload.spkId);
            }
          } else {
            return this.classifyFailure(e2, payload.spkId);
          }
        }
        return this.runPush(payload, ctx, depth + 1);
      }
      return this.classifyFailure(e, payload.spkId);
    }
  }

  /** Build the Service Order form and save it. Raises on failure (incl. NeedAddVehicleError). */
  private async buildAndSaveOrder(payload: TurbolyServiceOrderPayload, ctx: PushContext): Promise<PushResult> {
    const page = this.session.page_();
    // Verified sequence (proved live 2026-08-01, created SRO/BKS/26080001).
    await page.goto(`${this.baseUrl}/service_orders/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 1. Header native <select>s (Select2-enhanced; selectOption drives them).
    await page.selectOption('#order-type', { label: payload.type || 'General' }).catch(() => {});
    await page.selectOption('#store-id', { value: payload.storeTurbolyId });
    await page.waitForTimeout(2800); // advisors load after store (AJAX)

    await this.selectByLabelExact('#service-advisor-id', payload.serviceAdvisorName);
    await this.selectByLabelExact('#salesperson-id', payload.salespersonName);

    // 2-3. Customer + vehicle. Attach to existing Turboly records first; if the customer
    // isn't found, create customer+vehicle; if the customer is found but the vehicle isn't,
    // signal NeedAddVehicle so the caller creates it and retries.
    const reg = (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, '');
    const create = payload.customer.create;
    let attached = false;
    // THE CAR STAYS WITH ITS ORIGINAL PERSON: if this plate already exists in
    // Turboly, the SO attaches to the ORIGINAL registration's owner — even when
    // someone else (sister, driver) brings it in. The carrier becomes a notes
    // line, never a second owner.
    let effNama = create?.nama ?? '';
    let effPhone = create?.phone ?? '';
    const owner = await this.resolveVehicleOriginalOwner(reg);
    if (owner && (owner.phone || owner.name)) {
      const typedKey = effPhone ? canonPhoneKey(effPhone) : '';
      const ownerKey = owner.phone ? canonPhoneKey(owner.phone) : '';
      const differs = ownerKey
        ? typedKey !== '' && typedKey !== ownerKey
        : effNama.trim().toUpperCase() !== owner.name.trim().toUpperCase();
      if (differs) {
        this.notesExtra.push(`Dibawa oleh: ${effNama || '-'} (${effPhone ? localPhone(effPhone) : '-'}) — kendaraan tetap atas nama ${owner.name}`);
      }
      effNama = owner.name;
      if (owner.phone) effPhone = owner.phone;
    }
    // Match an existing customer only on EXACT name or matching phone (never a
    // partial/first result), so a new "FRANK" isn't merged into existing "FRANKI".
    const custOk = effNama || effPhone ? await this.tryPickCustomerExact(effNama, effPhone) : false;
    if (process.env.PUSH_DEBUG_MATCH) console.log(`MATCH effNama="${effNama}" effPhone="${effPhone}" custOk=${custOk} owner=${JSON.stringify(owner)}`);
    if (custOk) {
      await page.waitForTimeout(1200);
      const vehOk = await this.tryPickSelect2('#s2id_select2-input-vehicle', reg);
      if (vehOk) {
        attached = true;
        await page.waitForTimeout(1200);
        await this.dismissModals();
      } else {
        throw new NeedAddVehicleError(`customer "${create?.nama}" found but vehicle ${reg} not in Turboly`);
      }
    }
    if (!attached) {
      await this.createCustomerAndVehicle(payload);
      await page.waitForTimeout(1200);
      await this.dismissModals();
    }

    // 4. Odometer, reference token, plan date/time.
    await page.fill('#odometer', payload.odometer);
    await page.fill('#service_order_reference_no', payload.referenceNumber);
    await this.setPickerValue('#service-date', payload.planServiceDate);
    await this.setPickerValue('#service-time', payload.planServiceTime);
    // PUSH_DEBUG_FORM=1: dump every account/salesperson-ish + non-empty hidden
    // field the SO form would submit — for diffing robot vs manual saves.
    if (process.env.PUSH_DEBUG_FORM) {
      const dump = await page.evaluate(() => {
        const form = document.querySelector('form[action*="service_order"], form#new_service_order, form') as HTMLFormElement | null;
        if (!form) return ['(no form found)'];
        const out: string[] = [];
        new FormData(form).forEach((v, k) => {
          const val = String(v);
          if (/account|salesperson|advisor|store_id|reference|customer_id|vehicle/i.test(k) || (val !== '' && /hidden/i.test((form.querySelector(`[name="${CSS.escape(k)}"]`) as HTMLInputElement | null)?.type ?? ''))) {
            out.push(`${k} = ${val.slice(0, 60)}`);
          }
        });
        return out;
      });
      console.log('FORM DUMP:\n' + (dump as string[]).join('\n'));
    }
    const notesCombined = [payload.notes, ...this.notesExtra].filter(Boolean).join('\n');
    if (notesCombined) await page.fill('#service_order_notes', notesCombined).catch(() => {});

    // 5. Service lines (tab → Add Service Item → row Select2 + qty + description).
    // Each add must create a NEW row before we search it — otherwise a fast loop
    // silently drops a line (search lands on a stale/last row). Wait for the row
    // count to grow, then verify at the end that every line made it.
    await this.dismissModals();
    await page.getByRole('link', { name: 'Packages, Spareparts & Services' }).click();
    await page.waitForTimeout(700);
    const rowSel = '.select2-container.input-service-product';
    for (const line of payload.serviceLines) {
      const before = await page.locator(rowSel).count();
      await page.locator('a.btn-add-item', { hasText: /add service item/i }).first().click();
      for (let i = 0; i < 25 && (await page.locator(rowSel).count()) <= before; i++) await page.waitForTimeout(200);
      if ((await page.locator(rowSel).count()) <= before) throw new DataError(`service row did not appear for "${line.serviceName || line.expectedSku}"`);
      await page.waitForTimeout(400);
      await this.pickSelect2Locator(page.locator(rowSel).last(), line.serviceName || line.expectedSku);
      await page.waitForTimeout(600);
      await this.setLastServiceRow(page, line.qty, line.description || line.serviceName, line.priceIncTax);
    }
    const rowCount = await page.locator(rowSel).count();
    if (rowCount < payload.serviceLines.length) throw new DataError(`only ${rowCount}/${payload.serviceLines.length} service lines added`);
    // Spareparts aren't driven yet — fail LOUD rather than silently drop the line.
    if (payload.sparepartLines.length) throw new DataError(`${payload.sparepartLines.length} sparepart line(s) not supported by RPA yet: ${payload.sparepartLines.map((s) => s.expectedSku).join(', ')}`);

    const screenshotRef = await this.snapshot(page, `${payload.spkId}-presave`);

    // 6. Save — irreversible; re-assert the lease first.
    this.assertLease(ctx);
    // Re-assert plan date/time LAST — widget re-renders (new-customer modal flow)
    // can overwrite them with a stale "today"; verify and force once if needed.
    for (let i = 0; i < 2; i++) {
      await this.setPickerValue('#service-date', payload.planServiceDate);
      await this.setPickerValue('#service-time', payload.planServiceTime);
      await page.waitForTimeout(300);
      const got = await page.evaluate(() => ({
        d: (document.querySelector('#service-date') as HTMLInputElement | null)?.value,
        t: (document.querySelector('#service-time') as HTMLInputElement | null)?.value,
      }));
      if (got.d === payload.planServiceDate && got.t === payload.planServiceTime) break;
    }
    await this.dismissModals(); // clear any stray warning before the click can be intercepted
    await page.getByRole('button', { name: /^save$/i }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    // Because this vehicle may have in-progress docs, Turboly re-prompts a
    // confirmation modal ON save ("Continue?/Yes"). Affirm it, don't dismiss.
    await this.confirmModals();
    await page.waitForTimeout(3500);
    await page.waitForLoadState('networkidle').catch(() => {});
    await this.snapshot(page, `${payload.spkId}-aftersave`);

    // 7. Result: success redirects to the created SO; else an inline error shows.
    const inlineErr = await this.readInlineError(page).catch(() => null);
    const onDetailPage = /\/service_orders\/\d+/.test(page.url());
    const serviceOrderNo = onDetailPage ? await this.captureDocNumber(page) : null;
    const flashOk = /successfully (create|save)/i.test((await page.textContent('body').catch(() => '')) ?? '');
    const success = onDetailPage || flashOk;
    if (!success || (inlineErr && !serviceOrderNo)) {
      // A logged-out page is not a data verdict: nothing was written and the
      // retry logs back in. It used to be hidden behind Turboly's "Email is
      // unverified" banner; now that the banner is filtered, the real message
      // surfaces — and it must be classified as what it is, or every kicked
      // push is parked as permanent and a human is paged for nothing.
      if (/you have been logged out|please login again|you need to sign in|sign in or sign up/i.test(inlineErr ?? '')) {
        return { ...fail('transient', 'sesi Turboly ter-kick saat simpan — data belum tersimpan, dicoba ulang otomatis'), screenshotRef };
      }
      let msg = inlineErr ?? 'save did not confirm';
      if (/account code can't be blank/i.test(msg)) {
        msg += ' — konfigurasi store di Turboly mewajibkan Account Code tapi daftarnya KOSONG; definisikan Account Code (Setup → Accounting) atau matikan kewajibannya untuk store ini, lalu retry';
      }
      return { ...fail('data', msg), screenshotRef };
    }

    const serviceOrderUrl = /\/service_orders\/\d+/.test(page.url()) ? page.url() : null;
    // COMMIT BARRIER. The order EXISTS from here on. Anything that throws after
    // this point — a lost lease, a kicked session during approve, a dead page —
    // must not become a failure result, because the caller retries a failure and
    // the retry would create a SECOND order. Approve is best-effort; its verified
    // outcome is reported, never raised.
    let approved: boolean | null = null;
    try {
      if (ctx.approve) approved = await this.approveNow(page);
      await this.session.noteJobDone();
    } catch {
      approved = approved ?? false;
    }
    return { ok: true, serviceOrderNo, workOrderNo: null, verified: null, screenshotRef, serviceOrderUrl, approved };
  }

  /**
   * DRAFT → APPROVED on the just-saved Service Order, VERIFIED.
   *
   * The click alone proves nothing: "Approve" is a toolbar `<a class="btn">`
   * (the workflow bar's APPROVED chip is a status, not a control), and a
   * kicked/stale page swallows clicks silently — that combination is exactly
   * why orders kept sitting in Draft. So: click → confirm → read back, twice.
   * NEVER throws: the order already exists, and turning a failed approve into
   * a retry would create a SECOND order.
   */
  private async approveNow(page: Page): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (await this.isApproved(page)) return true;
      const clicked = await resolve(page, S.actions.approve)
        .first()
        .click({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) {
        await page
          .evaluate(`(() => {
            const hit = Array.from(document.querySelectorAll('a, button, input[type=submit]')).find((n) => /^approved?$/i.test(((n.innerText || n.value) || '').trim()));
            if (!hit) return false;
            hit.click();
            return true;
          })()`)
          .catch(() => false);
      }
      await page.waitForTimeout(1500);
      await this.confirmModals();
      await page.waitForTimeout(2500);
      await page.waitForLoadState('networkidle').catch(() => {});
      if (await this.isApproved(page)) return true;
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1800);
    }
    await this.snapshot(page, 'approve-not-confirmed').catch(() => null);
    return this.isApproved(page);
  }

  /**
   * Is this Service Order past DRAFT? Two independent signals, both required to
   * be meaningful: the page must still BE a Service Order detail page (a kicked
   * session shows neither the chip nor the action, which would otherwise read
   * as "approved"), and either the APPROVED chip is highlighted or the Approve
   * action is gone.
   */
  private async isApproved(page: Page): Promise<boolean> {
    return (await page
      .evaluate(`(() => {
        const body = document.body ? document.body.innerText : '';
        if (!/document\\s*number/i.test(body)) return false;
        const chip = Array.from(document.querySelectorAll('span, li, div')).find((el) => {
          if (/^approved$/i.test((el.innerText || '').trim()) === false) return false;
          const own = (el.className || '') + ' ' + (el.parentElement ? el.parentElement.className || '' : '');
          return /(^|[\\s_-])(active|current|selected)([\\s_-]|$)/i.test(own);
        });
        if (chip) return true;
        const action = Array.from(document.querySelectorAll('a, button, input[type=submit]')).find((n) => /^approved?$/i.test(((n.innerText || n.value) || '').trim()));
        return !action;
      })()`)
      .catch(() => false)) as boolean;
  }

  /** Screenshot + classify a raised error into a typed PushResult. */
  private async classifyFailure(e: unknown, spkId: string): Promise<PushResult> {
    const shot = await this.snapshot(this.session.page_(), `${spkId}-error`).catch(() => null);
    if (e instanceof LeaseLostError) return { ...fail('transient', (e as Error).message), screenshotRef: shot };
    if (e instanceof TransientError) return { ...fail('transient', (e as Error).message), screenshotRef: shot };
    if (e instanceof AuthChallengeError) return { ...fail('auth', (e as Error).message), screenshotRef: shot };
    if (e instanceof DataError) return { ...fail('data', (e as Error).message), screenshotRef: shot };
    // Turboly = ONE SESSION PER USER: a login elsewhere (web-form lookup, a human
    // in a browser) kicks this session mid-push and a sign-in modal blankets the
    // page, making every click time out. That's transient — retry logs in fresh.
    const kicked = await this.session
      .page_()
      .evaluate(() => /you need to sign in|you have been logged out|sign in or sign up/i.test(document.body?.innerText ?? ''))
      .catch(() => false);
    if (kicked) return { ...fail('transient', 'session kicked mid-push (another login elsewhere) — auto-retry'), screenshotRef: shot };
    const dataErr = await this.readInlineError(this.session.page_()).catch(() => null);
    if (dataErr) return { ...fail('data', dataErr), screenshotRef: shot };
    return { ...fail('structural', errMsg(e)), screenshotRef: shot };
  }

  /**
   * Add a new vehicle to an EXISTING customer via /vehicles/new — Turboly has no
   * inline add-vehicle on the SO form. Proven live 2026-08-01. The caller then
   * rebuilds the order so customer + vehicle attach normally.
   */
  private async addVehicleToExistingCustomer(payload: TurbolyServiceOrderPayload): Promise<void> {
    const page = this.session.page_();
    // Identity-first query: the ORIGINAL record's exact stored phone (Turboly's
    // search is prefix-based, so only the stored form is guaranteed to match),
    // else 0-form phone, else name.
    const cr = payload.customer.create;
    const phoneKey = cr?.phone && canonPhoneKey(cr.phone).length >= 8 ? canonPhoneKey(cr.phone) : '';
    let q = (phoneKey && cr?.phone ? localPhone(cr.phone) : '') || cr?.nama || payload.customer.existingQuery;
    if (phoneKey) {
      const orig = await this.resolveOriginalCustomer(phoneKey);
      if (process.env.PUSH_DEBUG_MATCH) console.log(`MATCH resolveOriginalCustomer(${phoneKey}) -> ${JSON.stringify(orig)}`);
      if (orig) q = orig.phone.trim();
    }
    if (!q) throw new DataError('cannot add vehicle: no customer identifier');
    await page.goto(`${this.baseUrl}/vehicles/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await this.modalSelect2Pick('s2id_select2-input-customer', q); // same container id as the SO form
    const reg = (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, '');
    await page.fill('#vehicle_registration', reg);
    await page.selectOption('#vehicle-type-select', { label: 'Car' }).catch(() => {});
    await page.waitForTimeout(600);
    if (payload.vehicleMake) {
      try {
        await this.modalSelect2Pick('s2id_vehicle-make-select', payload.vehicleMake);
      } catch (e) {
        // Never let a kicked session count as "make missing" — that creates a
        // duplicate make for a brand Turboly already has.
        if (e instanceof TransientError) throw e;
        // Operator confirmed on the form: create the new make, then rebuild.
        if (payload.createMakeConfirmed) throw new NeedCreateMakeError(`make "${payload.vehicleMake}" missing — operator confirmed create`);
        throw e;
      }
    }
    await page.waitForTimeout(900);
    await this.pickModelLoose('s2id_vehicle-model-select', payload.vehicleModel ?? '');
    if (payload.vehicleYear) await page.fill('#vehicle_year', payload.vehicleYear).catch(() => {});
    await page.fill('#vehicle_odometer', payload.odometer).catch(() => {});
    if (payload.vehicleColor) await page.fill('#vehicle_color', payload.vehicleColor).catch(() => {});
    await page.fill('#vehicle_km_next_service_default', String((Number(payload.odometer) || 0) + 5000)).catch(() => {});
    await page.fill('#vehicle_next_service_date_default', '3').catch(() => {});
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('input[type=submit], button')).find((x) => {
        const r = (x as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /save|simpan/i.test(((x as HTMLInputElement).value || (x as HTMLElement).textContent || ''));
      });
      if (b) { (b as HTMLElement).click(); return true; }
      return false;
    });
    if (!clicked) throw new DataError('new-vehicle save button not found');
    await page.waitForTimeout(4500);
    // Registering a plate that exists under ANOTHER customer makes Turboly show
    // a bare "rejected (422)" page on the post-save redirect — but the vehicle
    // IS created (proven live: duplicate registrations are allowed, one per
    // customer). Classify transient: the retry finds the new vehicle and
    // attaches normally; a genuinely failed create just 422s again to the cap.
    const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
    if (/rejected \(422\)|already been taken/i.test(bodyText)) {
      throw new TransientError(
        `422 page after add-vehicle for ${reg} (duplicate-plate redirect quirk; creation usually succeeded) — retrying to attach`,
      );
    }
    if (/\/vehicles\/new/.test(page.url())) {
      const err = await this.readInlineError(page).catch(() => null);
      throw new DataError(`add-vehicle-to-customer failed${err ? `: ${err}` : ' (check make/model match)'}`);
    }
  }

  private get baseUrl(): string {
    return (this.session as unknown as { cfg?: { baseUrl?: string } }).cfg?.baseUrl ?? 'https://sandbox.turboly.com';
  }

  /** Select an <option> by (normalized) label; fall back to the first real option. */
  /** Select ONLY on an exact label match; otherwise leave the field exactly as
   * Turboly rendered it — never auto-pick a first/random option (a wrong
   * advisor gets sales credit; Turboly's own default is the honest state). */
  private async selectByLabelExact(sel: string, label: string): Promise<void> {
    if (!label.trim()) return;
    const page = this.session.page_();
    const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');
    const opts = await page.$$eval(`${sel} option`, (els) => els.map((e) => ({ v: (e as HTMLOptionElement).value, t: (e.textContent ?? '').trim() })).filter((o) => o.v));
    // The store's user list arrives by AJAX after the store is picked; when we've
    // been kicked it arrives as sign-in HTML and the <select> stays empty, which
    // later surfaces as the data error "Service Advisor can't be blank".
    if (!opts.length) await this.assertSessionAlive('ambil daftar user store');
    const hit = opts.find((o) => norm(o.t) === norm(label));
    if (hit) await page.selectOption(sel, { value: hit.v }).catch(() => {});
  }

  /** Open a Select2-v3 widget by container selector, type, and pick first selectable result. */
  private async pickSelect2(containerSel: string, query: string): Promise<void> {
    const page = this.session.page_();
    await page.locator(`${containerSel} .select2-choice, ${containerSel}`).first().click();
    await this.dropPick(query);
  }
  private async pickSelect2Locator(container: import('playwright').Locator, query: string): Promise<void> {
    await container.click();
    await this.dropPick(query);
  }
  private async dropPick(query: string): Promise<void> {
    const page = this.session.page_();
    await page.waitForTimeout(400);
    let ready = false;
    for (let round = 0; round < 2 && !ready; round++) {
      // Re-typing the query re-triggers the remote search (round 2 = in-place retry).
      await this.typeInSelect2(page, '');
      await page.waitForTimeout(150);
      await this.typeInSelect2(page, query);
      for (let i = 0; i < 30; i++) { // sandbox remote search can take >15s under load
        const st = await page.evaluate(() => {
          const l = Array.from(document.querySelectorAll('#select2-drop .select2-results li'));
          return { sel: l.filter((x) => !/select2-(no-results|searching|selection-limit|disabled|more-results)/.test(x.className)).length, txt: l.map((x) => (x as HTMLElement).innerText).join(' ') };
        });
        if (st.sel > 0) { ready = true; break; }
        if (st.txt && !/searching/i.test(st.txt)) {
          // Same remote lookup, same trap: a logged-out drop renders "no results".
          await this.assertSessionAlive(`cari "${query}"`);
          throw new DataError(`no Turboly match for "${query}"`);
        }
        await page.waitForTimeout(700);
      }
    }
    if (!ready) throw new TransientError(`Turboly search for "${query}" timed out (still searching)`);
    await page.locator('#select2-drop .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results)').first().click({ timeout: 4000 });
  }

  /** Like pickSelect2 but returns false (and closes the drop) instead of throwing on no-match. */
  private async tryPickSelect2(containerSel: string, query: string): Promise<boolean> {
    const page = this.session.page_();
    try {
      await this.pickSelect2(containerSel, query);
      return true;
    } catch (e) {
      // A kicked session must not read as "vehicle not in Turboly" — that path
      // goes on to register the plate again.
      if (e instanceof TransientError) throw e;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      return false;
    }
  }

  /**
   * Attach to an existing customer ONLY on an exact name match (or a matching
   * phone) — never a first/partial result. Prevents "FRANK" wrongly attaching to
   * an existing "FRANKI". Returns false (→ create a new customer) if none matches.
   */
  /**
   * Resolve the ORIGINAL Turboly customer for a phone via the in-session JSON
   * lookup (`/lookup/customers.json`). Turboly's search is PREFIX-based on the
   * stored string, so every stored form (0812…, 812…, 62812…, +62812…) is
   * queried; among matches the LOWEST id (oldest registration) wins — the
   * original record owns the person. Returns the record's exact stored phone
   * (the only search term guaranteed to find it) or null when the phone is not
   * in Turboly at all. Throws nothing — a lookup hiccup returns undefined.
   */
  private async resolveOriginalCustomer(phoneKey: string): Promise<{ name: string; phone: string } | null | undefined> {
    try {
      const all: Array<{ id: number; name: string; phone: string }> = [];
      for (const t of ['0' + phoneKey, phoneKey, '62' + phoneKey, '+62' + phoneKey]) {
        const j = await this.lookupJson<{ customers?: Array<{ id: number; name?: unknown; phone?: unknown }> }>(
          `/lookup/customers.json?search_term=${encodeURIComponent(t)}&page_limit=30&page=1`,
          'cari customer asli',
        );
        for (const c of j?.customers ?? []) all.push({ id: c.id, name: String(c.name ?? ''), phone: String(c.phone ?? '') });
      }
      const mine = all
        .filter((c) => canonPhoneKey(c.phone) === phoneKey)
        .sort((a, b) => a.id - b.id);
      return mine[0] ?? null;
    } catch (e) {
      // "Logged out" is not "phone not in Turboly" — null here would register the
      // same person a second time.
      if (e instanceof TransientError) throw e;
      return undefined; // endpoint hiccup — caller falls back to select2 search
    }
  }

  /** The ORIGINAL registration owns the car: lowest vehicle id among exact
   * plate matches, with that row's owner name/phone (inline in the JSON). */
  private async resolveVehicleOriginalOwner(reg: string): Promise<{ name: string; phone: string } | null> {
    try {
      const j = await this.lookupJson<{
        vehicles?: Array<{ id: number; registration?: string; customer_name?: string; customer_phone?: string }>;
      }>(`/lookup/vehicles.json?search_term=${encodeURIComponent(reg)}&page_limit=30&page=1`, 'cari pemilik asli kendaraan');
      const raw = (j?.vehicles ?? []).map((v) => ({
        id: v.id, registration: String(v.registration ?? ''), name: String(v.customer_name ?? ''), phone: String(v.customer_phone ?? ''),
      }));
      const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const mine = raw
        .filter((v) => norm(v.registration) === norm(reg))
        .sort((a, b) => a.id - b.id);
      return mine[0] ? { name: mine[0].name, phone: mine[0].phone } : null;
    } catch (e) {
      // Logged out ≠ "plate unknown": the car would silently change owner.
      if (e instanceof TransientError) throw e;
      return null; // lookup hiccup — fall back to the typed identity
    }
  }


  /**
   * Type into a select2-v3 remote search box.
   *
   * fill() sets .value and fires `input`; select2-v3 only re-queries on KEY
   * events, so a filled box searches for nothing — the drop stays empty, the
   * caller reads "no match", and an EXISTING customer is created a second time.
   * Proven live: the same term found the customer in 3.2s when typed and never
   * when filled.
   */
  private async typeInSelect2(page: Page, query: string): Promise<void> {
    const input = page.locator('#select2-drop input').first();
    await input.waitFor({ state: 'visible', timeout: 8000 });
    await input.click({ timeout: 4000 }).catch(() => {});
    await input.press('Control+A').catch(() => {});
    await input.press('Meta+A').catch(() => {});
    await input.press('Backspace').catch(() => {});
    await page.waitForTimeout(120);
    await input.type(query, { delay: 25 });
  }

  private async tryPickCustomerExact(nama: string, phone: string): Promise<boolean> {
    const page = this.session.page_();
    // PHONE IS THE IDENTITY KEY (unique per person; one person, many cars).
    // Canonical key: 0223456789 / 223456789 / +62223456789 are all the SAME person.
    const phoneKey = phone && canonPhoneKey(phone).length >= 8 ? canonPhoneKey(phone) : '';
    let query = (phoneKey ? localPhone(phone) : nama || '').trim();
    if (phoneKey) {
      const orig = await this.resolveOriginalCustomer(phoneKey);
      if (process.env.PUSH_DEBUG_MATCH) console.log(`MATCH resolveOriginalCustomer(${phoneKey}) -> ${JSON.stringify(orig)}`);
      if (orig === null) return false; // phone not in Turboly → create new (stored 0-form)
      if (orig) query = orig.phone.trim(); // exact stored form — prefix search will find it
    }
    if (query.length < 3) return false; // Select2 remote search needs ≥3 chars
    try {
      await page.locator('#s2id_select2-input-customer .select2-choice, #s2id_select2-input-customer').first().click();
      await page.waitForTimeout(400);
      await this.typeInSelect2(page, query);
      let empties = 0;
      for (let i = 0; i < 18; i++) {
        const st = await page.evaluate(() => {
          // A result row is any <li> that is not one of select2's placeholders.
          // Requiring the class `select2-result-selectable` looked reasonable and
          // was FATAL: this build does not set it, so a drop showing the right
          // customer counted as zero results and the push created a duplicate.
          const l = Array.from(document.querySelectorAll('#select2-drop .select2-results li'));
          const pick = l.filter((x) => !/select2-(no-results|searching|selection-limit|disabled|more-results)/.test(x.className));
          return { sel: pick.length, txt: l.map((x) => (x as HTMLElement).innerText).join('||') };
        });
        if (st.sel > 0) break;
        // "No matches found" is NOT a verdict: select2-v3 renders it between
        // queries while the request is still in flight. Treating the first
        // sighting as final is what made an existing customer look absent — and
        // "absent" means create, which means a duplicate. Require it to persist.
        if (st.txt && !/searching|more characters/i.test(st.txt)) {
          if (++empties >= 3) break;
        } else {
          empties = 0;
        }
        await page.waitForTimeout(600);
      }
      if (process.env.PUSH_DEBUG_MATCH) {
        const dbg = await page.evaluate(() => ({
          dropVisible: !!document.querySelector('#select2-drop'),
          inputVal: (document.querySelector('#select2-drop input') as HTMLInputElement | null)?.value ?? '(no input)',
          rows: Array.from(document.querySelectorAll('#select2-drop .select2-results li')).map((x) => (x as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 70)),
        }));
        console.log(`MATCH query="${query}" drop=${JSON.stringify(dbg)}`);
      }
      // STRING-form evaluate on purpose: a named arrow inside a function-form
      // page.evaluate is compiled by tsx/esbuild into a __name(...) call that
      // does not exist in the browser, so the whole callback threw ReferenceError
      // and the catch below turned it into "no match" — i.e. every returning
      // customer was created again. A string is never transformed.
      const idx = (await page.evaluate(
        `(() => {
          var want = ${JSON.stringify(phoneKey)};
          var wantName = ${JSON.stringify((nama ?? '').trim().toUpperCase().replace(/\s+/g, ' '))};
          var lis = Array.prototype.slice.call(document.querySelectorAll('#select2-drop .select2-results li'))
            .filter(function (x) { return !/select2-(no-results|searching|selection-limit|disabled|more-results)/.test(x.className); });
          for (var i = 0; i < lis.length; i++) {
            var text = lis[i].innerText || '';
            if (want) {
              if (text.replace(/\\D/g, '').indexOf(want) >= 0) return i;
            } else if (wantName) {
              var name = (text.split(/\\s[-\u2013\u2014]\\s|\\n/)[0] || '').trim().toUpperCase().replace(/\\s+/g, ' ');
              if (name === wantName) return i;
            }
          }
          return -1;
        })()`,
      )) as number;
      if (process.env.PUSH_DEBUG_MATCH) console.log(`MATCH idx=${idx}`);
      if (idx < 0) {
        // No match here means "create a new customer" — a verdict we may not
        // reach on a drop that was empty only because we'd been kicked.
        await this.assertSessionAlive('cari customer');
        await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); return false;
      }
      await page.locator('#select2-drop .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results)').nth(idx).click({ timeout: 4000 });
      await page.waitForTimeout(500);
      return true;
    } catch (e) {
      if (e instanceof TransientError) throw e;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      return false;
    }
  }

  /**
   * Create a brand-new customer + vehicle via the "Add New Customer" modal, then
   * let Turboly auto-select them into the Service Order. Store/Service Tax/Country
   * are pre-filled by Turboly (we picked the store already). Proven live 2026-08-01.
   */
  private async createCustomerAndVehicle(payload: TurbolyServiceOrderPayload): Promise<void> {
    const page = this.session.page_();
    const c = payload.customer.create;
    // Open the modal (the control is an <a>/<button>/<input> labelled "Add New Customer").
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a,button,input')).find((n) => /add new customer/i.test(((n as HTMLElement).textContent || (n as HTMLInputElement).value || '').trim()));
      if (el) (el as HTMLElement).click();
    });
    await page.waitForTimeout(2500);

    // Customer
    await page.fill('#customer_name', c?.nama || 'Customer');
    if (c?.phone) await page.fill('#customer_phone', localPhone(c.phone)).catch(() => {});
    if (c?.alamat) await page.fill('#customer_addresses_attributes_0_address', c.alamat).catch(() => {});

    // Vehicle
    const reg = (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, '');
    await page.fill('#customer_vehicles_attributes_0_registration', reg);
    await page.selectOption('#vehicle-type-select', { label: 'Car' }).catch(() => {});
    await page.waitForTimeout(700);
    if (payload.vehicleMake) {
      try {
        await this.modalSelect2Pick('s2id_vehicle-make-select', payload.vehicleMake);
      } catch (e) {
        // Same guard as /vehicles/new: kicked ≠ missing make.
        if (e instanceof TransientError) throw e;
        // Operator confirmed on the form: create the new make, then rebuild.
        if (payload.createMakeConfirmed) throw new NeedCreateMakeError(`make "${payload.vehicleMake}" missing — operator confirmed create`);
        throw e;
      }
    }
    await page.waitForTimeout(900);
    await this.pickModelLoose('s2id_vehicle-model-select', payload.vehicleModel ?? '');
    if (payload.vehicleYear) await page.fill('#customer_vehicles_attributes_0_year', payload.vehicleYear).catch(() => {});
    await page.fill('#customer_vehicles_attributes_0_odometer', payload.odometer).catch(() => {});
    if (payload.vehicleColor) await page.fill('#customer_vehicles_attributes_0_color', payload.vehicleColor).catch(() => {});
    await page.fill('#customer_vehicles_attributes_0_km_next_service_default', String((Number(payload.odometer) || 0) + 5000)).catch(() => {});
    // "Month next service default" is a NUMBER of months, not a date.
    await page.fill('#customer_vehicles_attributes_0_next_service_date_default', '3').catch(() => {});

    // Save the modal (its own submit button, class starts turbo-btn-save-cust*; a
    // DOM click bypasses the fixed-footer actionability quirk). NOT the SO's save.
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('input[class*="turbo-btn-save-cust"]')).find((x) => {
        const r = (x as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(x as HTMLElement).display !== 'none';
      });
      if (b) { (b as HTMLElement).click(); return true; }
      return false;
    });
    if (!clicked) throw new DataError('could not find the New Customer save button');
    await page.waitForTimeout(5000);

    // If the modal's save button is still visible, the save was rejected — surface why.
    const stillOpen = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[class*="turbo-btn-save-cust"]')).some((x) => {
        const r = (x as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
    );
    if (stillOpen) {
      const err = await this.readInlineError(page).catch(() => null);
      throw new DataError(`new-customer create rejected${err ? `: ${err}` : ' (check make/model match)'}`);
    }
  }

  /**
   * Create a NEW vehicle make in Turboly (operator-confirmed on the form), plus a
   * first model named after the typed tipe so the vehicle can be created at all.
   * Fails with a clear DataError if the Turboly account lacks the permission
   * ("Sorry you can't view that page") — grant it under Users & Permissions.
   */
  private async ensureMakeExists(makeName: string, firstModel: string): Promise<void> {
    const page = this.session.page_();
    const name = makeName.trim().toUpperCase();
    // 1. Create the make.
    await page.goto(`${this.baseUrl}/vehicle_makes/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    if (!/vehicle_makes\/new/.test(page.url())) {
      throw new DataError(`akun Turboly tidak punya izin membuat Vehicle Make baru ("${name}") — aktifkan izin di Setup → Users & Permissions, atau tambah manual`);
    }
    const nameInput = page.locator('#vehicle_make_name, input[name="vehicle_make[name]"]').first();
    if ((await nameInput.count()) === 0) throw new DataError(`form Vehicle Make tidak dikenali — tambah merk "${name}" manual di Turboly`);
    await nameInput.fill(name);
    // A vehicle-type select may exist — pick Car when present.
    await page.selectOption('#vehicle-type-select, select[name*="vehicle_type"]', { label: 'Car' }).catch(() => {});
    await page.locator('input[name=commit], input[type=submit]').first().click();
    await page.waitForTimeout(2500);
    if (/vehicle_makes\/new/.test(page.url())) {
      const err = await this.readInlineError(page).catch(() => null);
      throw new DataError(`gagal membuat merk "${name}"${err ? `: ${err}` : ''}`);
    }
    this.notesExtra.push(`Merk baru dibuat di Turboly: ${name}`);
    // 2. A brand-new make has zero models — create a first model (the typed tipe).
    const modelName = (firstModel || 'STANDARD').trim().toUpperCase();
    await page.goto(`${this.baseUrl}/vehicle_models/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    await page.selectOption('#vehicle-type-select', { label: 'Car' }).catch(() => {});
    await page.waitForTimeout(1200);
    const picked = await page.selectOption('#vehicle-make-select', { label: name }).then(() => true).catch(() => false);
    if (picked) {
      await page.waitForTimeout(400);
      await page.fill('#vehicle_model_name', modelName).catch(() => {});
      await page.locator('input[name=commit], input[type=submit]').first().click().catch(() => {});
      await page.waitForTimeout(2500);
      if (!/vehicle_models\/new/.test(page.url())) this.notesExtra.push(`Model baru dibuat: ${name} ${modelName}`);
    }
  }

  /**
   * ANY-tipe policy: try the exact typed model; if Turboly doesn't have it, pick
   * the make's MOST SIMILAR model as a stand-in (Jaro-Winkler + containment
   * boost) and record the typed tipe in the order notes. The model list loads
   * remotely, so the fallback polls until it resolves. Only fails if the make
   * truly has no models.
   */
  private async pickModelLoose(containerId: string, typed: string): Promise<void> {
    const q = (typed ?? '').trim();
    if (q) {
      try {
        await this.modalSelect2Pick(containerId, q);
        return;
      } catch { /* fall through to most-similar stand-in */ }
    }
    const page = this.session.page_();
    // Reuse the drop the failed search left OPEN: clear its query with REAL
    // keyboard events (select2-v3 re-queries on keyup — programmatic fill('')
    // doesn't fire it, and NEVER press Escape here: it closes the whole
    // Bootstrap modal). Empty-q path: no stale drop, a plain click opens it.
    const dropInput = page.locator('.select2-drop:visible input.select2-input, #select2-drop:visible input').last();
    if (await dropInput.count()) {
      await dropInput.click({ timeout: 4000 }).catch(() => {});
      await page.keyboard.press('ControlOrMeta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
    } else {
      await page.locator(`#${containerId} .select2-choice, #${containerId}`).first().click({ timeout: 8000 });
    }
    // Poll: the model list is a remote fetch — "Searching…" until it lands.
    let items: string[] = [];
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => {
        const lis = Array.from(document.querySelectorAll('.select2-drop .select2-results li, #select2-drop .select2-results li'));
        return {
          searching: lis.some((l) => l.classList.contains('select2-searching')),
          texts: lis.filter((l) => !/select2-(no-results|searching|selection-limit|disabled|more-results)/.test(l.className)).map((l) => (l as HTMLElement).innerText.trim()),
        };
      });
      if (!st.searching && st.texts.length) { items = st.texts; break; }
      if (!st.searching && i > 3) break; // resolved to empty
    }
    if (!items.length) {
      // This is where a kicked session became a permanent verdict: the drop is
      // fed by /lookup/vehicle_models, which answers sign-in HTML when we've
      // been logged out, so TOYOTA/Avanza read as "no models" minutes after the
      // same car pushed fine. Ask that endpoint directly — only a live JSON
      // answer is allowed to be empty.
      await this.assertSessionAlive('ambil daftar model', await this.modelLookupPath());
      await page.keyboard.press('Escape').catch(() => {});
      throw new DataError(`make has no models in Turboly (typed tipe "${q || '—'}")`);
    }
    // Most-similar: containment (either direction) outranks fuzzy distance.
    const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();
    const nq = norm(q);
    let bestIdx = 0;
    let bestScore = -1;
    items.forEach((it, i) => {
      const ni = norm(it);
      const contain = nq && (ni.includes(nq) || nq.includes(ni)) ? 0.95 : 0;
      const score = Math.max(contain, nq ? jaroWinkler(nq, ni) : 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    const label = items[bestIdx] ?? items[0]!;
    await page.locator('.select2-drop .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results), #select2-drop .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results)').nth(bestIdx).click({ timeout: 4000 });
    await page.waitForTimeout(400);
    this.notesExtra.push(q ? `Tipe diketik "${q}" tidak ada di katalog — model paling mirip dipakai: ${label}` : `Tipe kosong — model Turboly dipakai: ${label}`);
  }

  /** Select2-v3 pick inside the New Customer modal (drop is `.select2-drop`, opens on real mousedown). */
  private async modalSelect2Pick(containerId: string, query: string): Promise<void> {
    const page = this.session.page_();
    const q = query.trim(); // a trailing space can hang Turboly's remote search forever
    await page.locator(`#${containerId} .select2-choice, #${containerId} .select2-choices, #${containerId}`).first().click({ timeout: 8000 });
    await page.waitForTimeout(400);
    await page.locator('.select2-drop:visible input.select2-input, #select2-drop:visible input').first().fill(q);
    const results = '.select2-drop:visible .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results), #select2-drop:visible .select2-results li:not(.select2-no-results):not(.select2-searching):not(.select2-selection-limit):not(.select2-disabled):not(.select2-more-results)';
    let found = false;
    for (let i = 0; i < 20; i++) {
      if ((await page.locator(results).count()) > 0) { found = true; break; }
      const txt = await page.locator('.select2-drop:visible .select2-results, #select2-drop:visible .select2-results').first().innerText().catch(() => '');
      if (txt && !/searching|loading|more characters/i.test(txt)) {
        // "No results" from a select2 fed sign-in HTML looks identical to a real
        // no-match — and here it would go on to CREATE a duplicate make.
        await this.assertSessionAlive(`cari "${q}"`);
        throw new DataError(`no Turboly match for "${q}"`);
      }
      await page.waitForTimeout(500);
    }
    // Search never resolved (stuck "Searching…") — a data/timeout condition, not a broken page.
    if (!found) throw new TransientError(`Turboly search for "${q}" returned no results (timed out)`);
    await page.locator(results).first().click({ timeout: 5000 });
    await page.waitForTimeout(500);
  }

  /** Dismiss any visible Turboly warning/info modal (e.g. in-progress-docs) by clicking OK. */
  private async dismissModals(): Promise<void> {
    const page = this.session.page_();
    for (let i = 0; i < 4; i++) {
      // Direct DOM click bypasses the modal overlay intercepting pointer events;
      // the OK/Close control may be a <button> OR an <a>.
      const clicked = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('.modal-scrollable button, .modal-scrollable a, .modal button, .modal a, [role=dialog] button, [role=dialog] a'));
        const ok = nodes.find((n) => (n as HTMLElement).offsetParent !== null && /^(ok|close|tutup)$/i.test(((n as HTMLElement).textContent ?? '').trim()));
        if (ok) { (ok as HTMLElement).click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(600);
    }
  }

  /** Affirm any confirmation modal (Yes/Continue/Save-anyway) — the opposite of dismiss. */
  private async confirmModals(): Promise<void> {
    const page = this.session.page_();
    for (let i = 0; i < 3; i++) {
      const clicked = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('.modal-scrollable button, .modal-scrollable a, .modal button, .modal a, [role=dialog] button, [role=dialog] a'));
        const yes = nodes.find((n) => (n as HTMLElement).offsetParent !== null && /^(ya|yes|ok|save|simpan|lanjut|lanjutkan|continue|confirm|proceed)$/i.test(((n as HTMLElement).textContent ?? '').trim()));
        if (yes) { (yes as HTMLElement).click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(1200);
    }
  }

  /** Set a datepicker/timepicker input by value + dispatch change (typed fill mangles it).
   *  Also updates the jQuery datepicker's INTERNAL state — otherwise a later widget
   *  re-render (e.g. after the new-customer modal saves) writes its stale "today"
   *  back over our value (bit us across the WIB/UTC midnight window). */
  private async setPickerValue(sel: string, value: string): Promise<void> {
    const page = this.session.page_();
    await page.evaluate(({ sel, value }) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const w = window as unknown as { jQuery?: (s: string) => { data: (k: string) => unknown; datepicker: (m: string, v: string) => void; val: (v?: string) => string } };
      try {
        const $el = w.jQuery ? w.jQuery(sel) : null;
        if ($el && $el.data('datepicker')) $el.datepicker('update', value);
      } catch { /* widget API absent — value+change already set */ }
    }, { sel, value });
  }

  /** Set qty + description (+ quoted price when given) on the newest service row. */
  private async setLastServiceRow(page: Page, qty: number, description: string, priceIncTax?: number | null): Promise<void> {
    await page.evaluate(({ qty, description, priceIncTax }) => {
      const rows = Array.from(document.querySelectorAll('tr.additional-line-item-row'));
      const row = rows[rows.length - 1];
      if (!row) return;
      const fire = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const q = row.querySelector('input[name*="[quantity]"]') as HTMLInputElement | null;
      if (q) fire(q, String(qty || 1));
      const d = row.querySelector('input[name*="[description]"], textarea[name*="[description]"], input[name*="[notes]"]') as HTMLInputElement | null;
      if (d) fire(d, description || 'Service');
      // Quoted price from the form (harga Rp) → Price Inc Tax; skip when not quoted
      // so Turboly's catalog price stays (never overwrite a real price with 0).
      if (priceIncTax != null && priceIncTax > 0) {
        const price = Array.from(row.querySelectorAll('input')).find((i) => /price/i.test(i.getAttribute('name') || '') && !/discount/i.test(i.getAttribute('name') || '')) as HTMLInputElement | undefined;
        if (price) fire(price, String(priceIncTax));
      }
    }, { qty, description, priceIncTax: priceIncTax ?? null });
  }

  async verifyByToken(doc: SpkDoc): Promise<VerifyResult> {
    // MUST be a fresh navigation — never reuse the write flow's state.
    await this.session.ensureLoggedIn();
    const page = this.session.page_();
    const notFound = { found: false, serviceOrderNo: null, store: null, lineCount: null, lineSkus: [], km: null };

    // Preferred path: go straight to the created SO detail page (captured on save).
    // This avoids the fragile list-filter selectors entirely.
    const directUrl = doc.turboly.serviceOrderUrl;
    if (directUrl && /\/service_orders\/\d+/.test(directUrl)) {
      // Retry the read-back navigation — a transient timeout shouldn't leave a
      // successfully-created SO stuck as unverified.
      let navOk = false;
      for (let i = 0; i < 3 && !navOk; i++) {
        try {
          await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navOk = true;
        } catch {
          await page.waitForTimeout(1500);
        }
      }
      await page.waitForTimeout(1500);
      return this.readbackFromDetail(page, doc);
    }

    // Fallback: search the Service Orders list by document number / registration.
    await page.goto(S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' });
    const docNo = doc.turboly.serviceOrderNo;
    if (docNo) {
      await fillInput(page, S.list.documentNumberFilter, docNo).catch(() => {});
    } else {
      await fillInput(page, S.list.registrationFilter, doc.vehicle.noPolisi.display).catch(() => {});
    }
    await resolve(page, S.list.searchButton).click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});

    const rowLoc = docNo ? S.list.rowByDocNo(docNo) : S.list.rowByRegistration(doc.vehicle.noPolisi.display);
    if (!(await exists(page, rowLoc, 6000))) return notFound;
    await resolve(page, rowLoc).first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
    return this.readbackFromDetail(page, doc);
  }

  /** On a Service Order detail page, prove identity by REFERENCE NUMBER == our token. */
  private async readbackFromDetail(page: Page, doc: SpkDoc): Promise<VerifyResult> {
    // The reference field is an <input>; read its value robustly by DOM scan,
    // then fall back to a whole-body text search for the token.
    const token = doc.push.correlationToken;
    const refVal = await page.evaluate(() => {
      const el = document.querySelector('#service_order_reference_no') as HTMLInputElement | null;
      return el?.value ?? null;
    }).catch(() => null);
    const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
    const tokenMatches = (refVal ?? '').includes(token) || bodyText.includes(token);

    const km = await page.evaluate(() => {
      const el = document.querySelector('#odometer') as HTMLInputElement | null;
      return el?.value ?? null;
    }).catch(() => null);
    const savedNo = await this.captureDocNumber(page);

    const lineSkus = await page
      .locator('table')
      .last()
      .locator('tbody tr')
      .allTextContents()
      .then((rows) => rows.map((r) => r.trim()).filter(Boolean))
      .catch(() => [] as string[]);

    return {
      found: tokenMatches,
      serviceOrderNo: savedNo ?? doc.turboly.serviceOrderNo,
      store: null,
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

  /**
   * Turboly = ONE SESSION PER USER, and a kicked session answers the /lookup/*
   * JSON endpoints with the SIGN-IN HTML instead of JSON. Parsed as "no
   * results", that became a confident PERMANENT data verdict — TOYOTA / Avanza
   * was reported as "make has no models" minutes after the same car had pushed
   * fine. Kicked = the response lands on /users/sign_in, isn't JSON, or reads as
   * logged-out; kicked is never an answer about the data.
   */
  private async readLookup(path: string): Promise<{ url: string; ok: boolean; ctype: string; body: string } | null> {
    return this.session
      .page_()
      .evaluate(async (p: string) => {
        const res = await fetch(p, { headers: { accept: 'application/json' } });
        return { url: res.url, ok: res.ok, ctype: (res.headers.get('content-type') ?? '').toLowerCase(), body: await res.text() };
      }, path)
      .catch(() => null);
  }

  private lookupIsSignIn(r: { url: string; ok: boolean; ctype: string; body: string }): boolean {
    return (
      /\/users\/sign_in/.test(r.url) ||
      (r.ok && !r.ctype.includes('json')) ||
      /you have been logged out|sign in or sign up|please login again/i.test(r.body.slice(0, 4000))
    );
  }

  /** Parsed lookup JSON. Null when the endpoint merely misbehaves (callers keep
   *  their existing fallbacks); TransientError when we're logged out. */
  private async lookupJson<T>(path: string, what: string): Promise<T | null> {
    const r = await this.readLookup(path);
    if (!r) return null;
    if (this.lookupIsSignIn(r)) throw new TransientError(`sesi Turboly ter-kick saat ${what} — dicoba ulang otomatis`);
    if (!r.ok) return null;
    try {
      return JSON.parse(r.body) as T;
    } catch {
      return null;
    }
  }

  /** Guard for emptiness read off the DOM: select2 drops and the store's user
   *  <select> are filled from those same lookups, so an empty one may only mean
   *  we were kicked. Ask an endpoint before calling it a data verdict. */
  private async assertSessionAlive(what: string, probePath = '/lookup/customers.json?search_term=zzq&page_limit=1&page=1'): Promise<void> {
    const r = await this.readLookup(probePath);
    if (r && this.lookupIsSignIn(r)) throw new TransientError(`sesi Turboly ter-kick saat ${what} — dicoba ulang otomatis`);
  }

  /** The exact endpoint the model select2 reads, for the make now selected. */
  private async modelLookupPath(): Promise<string> {
    const makeId = await this.session
      .page_()
      .evaluate(() => (document.querySelector('#vehicle-make-select') as HTMLSelectElement | null)?.value ?? '')
      .catch(() => '');
    return `/lookup/vehicle_models?search_term=&vehicle_type=&vehicle_make=${encodeURIComponent(makeId)}&page=1&page_limit=1`;
  }

  private async captureDocNumber(page: Page): Promise<string | null> {
    const v = await readValue(page, S.savedDocNumber);
    if (v && /[A-Z]{2,}\/[A-Z0-9]+\/\d+/.test(v)) return v.trim();
    // Fallback: scan the page for the SBO/BRANCH/NNNN pattern.
    const body = await page.textContent('body').catch(() => '');
    const m = /\b([A-Z]{2,4}\/[A-Z0-9]{2,6}\/\d{6,})\b/.exec(body ?? '');
    return m?.[1] ?? v?.trim() ?? null;
  }

  private async readInlineError(page: Page): Promise<string | null> {
    // Turboly's validation banner is Bootstrap-2 era (.alert-error), e.g.
    // "Can't create Service Order: Error — Service Advisor can't be blank".
    for (const sel of ['.alert-error', '.alert-danger', '#error_explanation', '.invalid-feedback', '[role="alert"]', '.text-danger']) {
      const loc = page.locator(sel);
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        // Turboly renders tenant-wide banners ("Email is unverified") in the same
        // .alert-error box as validation output; taking the first hit reported
        // that as the reason a save failed and hid the real cause.
        const t = (await loc.nth(i).innerText().catch(() => ''))?.trim().replace(/\s*\n\s*/g, ' • ');
        if (t && !/success/i.test(t) && !/email is unverified|verify your email|mohon melakukan pembayaran/i.test(t)) return t;
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

/** A data-quality failure (no match, rejected create) — retrying won't help; route to review. */
export class DataError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DataError';
  }
}

/** A slow/flaky remote search — retry later; the same input may succeed. */
export class TransientError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransientError';
  }
}

/** Control-flow signal: operator-confirmed NEW make must be created, then rebuild. */
export class NeedCreateMakeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NeedCreateMakeError';
  }
}

/** Control-flow signal: customer exists but the vehicle doesn't → add it, then rebuild. */
export class NeedAddVehicleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NeedAddVehicleError';
  }
}

function fail(failureClass: NonNullable<PushResult['failureClass']>, error: string): PushResult {
  return { ok: false, serviceOrderNo: null, workOrderNo: null, verified: null, failureClass, error };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
