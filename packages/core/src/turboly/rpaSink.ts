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

    await this.selectByLabelOrFirst('#service-advisor-id', payload.serviceAdvisorName);
    await this.selectByLabelOrFirst('#salesperson-id', payload.salespersonName);

    // 2-3. Customer + vehicle. Attach to existing Turboly records first; if the customer
    // isn't found, create customer+vehicle; if the customer is found but the vehicle isn't,
    // signal NeedAddVehicle so the caller creates it and retries.
    const reg = (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, '');
    const create = payload.customer.create;
    let attached = false;
    // Match an existing customer only on EXACT name or matching phone (never a
    // partial/first result), so a new "FRANK" isn't merged into existing "FRANKI".
    const custOk = create?.nama || create?.phone ? await this.tryPickCustomerExact(create?.nama ?? '', create?.phone ?? '') : false;
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
      return { ...fail('data', inlineErr ?? 'save did not confirm'), screenshotRef };
    }

    const serviceOrderUrl = /\/service_orders\/\d+/.test(page.url()) ? page.url() : null;
    if (ctx.approve && (await exists(page, S.actions.approve, 4000))) {
      this.assertLease(ctx);
      await resolve(page, S.actions.approve).click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    await this.session.noteJobDone();
    return { ok: true, serviceOrderNo, workOrderNo: null, verified: null, screenshotRef, serviceOrderUrl };
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
    if (/\/vehicles\/new/.test(page.url())) {
      const err = await this.readInlineError(page).catch(() => null);
      throw new DataError(`add-vehicle-to-customer failed${err ? `: ${err}` : ' (check make/model match)'}`);
    }
  }

  private get baseUrl(): string {
    return (this.session as unknown as { cfg?: { baseUrl?: string } }).cfg?.baseUrl ?? 'https://sandbox.turboly.com';
  }

  /** Select an <option> by (normalized) label; fall back to the first real option. */
  private async selectByLabelOrFirst(sel: string, label: string): Promise<void> {
    const page = this.session.page_();
    const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');
    const opts = await page.$$eval(`${sel} option`, (els) => els.map((e) => ({ v: (e as HTMLOptionElement).value, t: (e.textContent ?? '').trim() })).filter((o) => o.v));
    const hit = opts.find((o) => norm(o.t) === norm(label));
    await page.selectOption(sel, { value: (hit ?? opts[0])?.v }).catch(() => {});
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
      await page.locator('#select2-drop input').first().fill('');
      await page.waitForTimeout(150);
      await page.locator('#select2-drop input').first().fill(query);
      for (let i = 0; i < 30; i++) { // sandbox remote search can take >15s under load
        const st = await page.evaluate(() => {
          const l = Array.from(document.querySelectorAll('#select2-drop .select2-results li'));
          return { sel: l.filter((x) => x.classList.contains('select2-result-selectable')).length, txt: l.map((x) => (x as HTMLElement).innerText).join(' ') };
        });
        if (st.sel > 0) { ready = true; break; }
        if (st.txt && !/searching/i.test(st.txt)) throw new DataError(`no Turboly match for "${query}"`);
        await page.waitForTimeout(700);
      }
    }
    if (!ready) throw new TransientError(`Turboly search for "${query}" timed out (still searching)`);
    await page.locator('#select2-drop .select2-results li.select2-result-selectable').first().click({ timeout: 4000 });
  }

  /** Like pickSelect2 but returns false (and closes the drop) instead of throwing on no-match. */
  private async tryPickSelect2(containerSel: string, query: string): Promise<boolean> {
    const page = this.session.page_();
    try {
      await this.pickSelect2(containerSel, query);
      return true;
    } catch {
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
    const page = this.session.page_();
    try {
      const raw = await page.evaluate(async (terms: string[]) => {
        const all: Array<{ id: number; name: string; phone: string }> = [];
        for (const t of terms) {
          const r = await fetch(`/lookup/customers.json?search_term=${encodeURIComponent(t)}&page_limit=30&page=1`, { headers: { accept: 'application/json' } });
          if (r.ok) {
            const j = await r.json();
            for (const c of j.customers ?? []) all.push({ id: c.id, name: String(c.name ?? ''), phone: String(c.phone ?? '') });
          }
        }
        return all;
      }, ['0' + phoneKey, phoneKey, '62' + phoneKey, '+62' + phoneKey]);
      const mine = raw
        .filter((c) => canonPhoneKey(c.phone) === phoneKey)
        .sort((a, b) => a.id - b.id);
      return mine[0] ?? null;
    } catch {
      return undefined; // endpoint hiccup — caller falls back to select2 search
    }
  }

  private async tryPickCustomerExact(nama: string, phone: string): Promise<boolean> {
    const page = this.session.page_();
    // PHONE IS THE IDENTITY KEY (unique per person; one person, many cars).
    // Canonical key: 0223456789 / 223456789 / +62223456789 are all the SAME person.
    const phoneKey = phone && canonPhoneKey(phone).length >= 8 ? canonPhoneKey(phone) : '';
    let query = (phoneKey ? localPhone(phone) : nama || '').trim();
    if (phoneKey) {
      const orig = await this.resolveOriginalCustomer(phoneKey);
      if (orig === null) return false; // phone not in Turboly → create new (stored 0-form)
      if (orig) query = orig.phone.trim(); // exact stored form — prefix search will find it
    }
    if (query.length < 3) return false; // Select2 remote search needs ≥3 chars
    try {
      await page.locator('#s2id_select2-input-customer .select2-choice, #s2id_select2-input-customer').first().click();
      await page.waitForTimeout(400);
      await page.locator('#select2-drop input').first().fill(query);
      for (let i = 0; i < 18; i++) {
        const st = await page.evaluate(() => {
          const l = Array.from(document.querySelectorAll('#select2-drop .select2-results li'));
          return { sel: l.filter((x) => x.classList.contains('select2-result-selectable')).length, txt: l.map((x) => (x as HTMLElement).innerText).join('||') };
        });
        if (st.sel > 0) break;
        if (st.txt && !/searching|more characters/i.test(st.txt)) break;
        await page.waitForTimeout(600);
      }
      const idx = await page.evaluate(({ nama, phoneKey }) => {
        const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');
        const lis = Array.from(document.querySelectorAll('#select2-drop .select2-results li.select2-result-selectable'));
        for (let i = 0; i < lis.length; i++) {
          const text = (lis[i] as HTMLElement).innerText || '';
          if (phoneKey) {
            // Identity = phone ONLY (canonical: contains works for 0/62/bare forms).
            if (text.replace(/\D/g, '').includes(phoneKey)) return i;
          } else {
            // No phone typed → fall back to exact-name matching (as before).
            const name = text.split(/\s[-–—]\s|\n/)[0] ?? '';
            if (!!nama && norm(name) === norm(nama)) return i;
          }
        }
        return -1;
      }, { nama, phoneKey });
      if (idx < 0) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); return false; }
      await page.locator('#select2-drop .select2-results li.select2-result-selectable').nth(idx).click({ timeout: 4000 });
      await page.waitForTimeout(500);
      return true;
    } catch {
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
          texts: lis.filter((l) => l.classList.contains('select2-result-selectable')).map((l) => (l as HTMLElement).innerText.trim()),
        };
      });
      if (!st.searching && st.texts.length) { items = st.texts; break; }
      if (!st.searching && i > 3) break; // resolved to empty
    }
    if (!items.length) {
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
    await page.locator('.select2-drop .select2-results li.select2-result-selectable, #select2-drop .select2-results li.select2-result-selectable').nth(bestIdx).click({ timeout: 4000 });
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
    const results = '.select2-drop:visible .select2-results li.select2-result-selectable, #select2-drop:visible .select2-results li.select2-result-selectable';
    let found = false;
    for (let i = 0; i < 20; i++) {
      if ((await page.locator(results).count()) > 0) { found = true; break; }
      const txt = await page.locator('.select2-drop:visible .select2-results, #select2-drop:visible .select2-results').first().innerText().catch(() => '');
      if (txt && !/searching|loading|more characters/i.test(txt)) throw new DataError(`no Turboly match for "${q}"`);
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
