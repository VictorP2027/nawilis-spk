import { connect, close, collections } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * READ-ONLY: what does the service-product picker actually return?
 *
 * rpaSink.dropPick() clicks the FIRST result of a select2 remote search and
 * never checks that it is the product it asked for; the only post-check is that
 * the row attached to SOME catalogue entry (rpaSink.ts ~1868). And the search
 * term is the MIRROR's product name when the SKU is known
 * (payload.ts: `const serviceName = product?.name ?? sku`). So when one product
 * name is a prefix of another — "Periodic Maintenance" vs "Periodic Maintenance
 * GSM Grade 1" — the line can silently attach to the wrong product at the wrong
 * price. That is exactly what the sandbox showed: TPI-NAWJAS-PM came back as
 * GSM-NAW-PMG1 at 337.500.
 *
 * This opens the order form and types the queries; it NEVER saves, submits, or
 * changes anything. No order is created.
 *
 *   node --import tsx apps/worker/src/probe-product-search.ts --q="Periodic Maintenance"
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const QUERIES = (arg('q') ?? '').split('|').map((s) => s.trim()).filter(Boolean);
/** --customers=<phone>: how many customer records carry this number? */
const CUSTOMERS = (arg('customers') ?? '').trim();
/** --vehicle=<plate>: who does Turboly say owns this car? Same lookup the pusher uses. */
const VEHICLE = (arg('vehicle') ?? '').toUpperCase().replace(/\s/g, '');
const STORE = arg('store') ?? 'Nawilis Bekasi';

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  console.log(`base=${config.turbolyBaseUrl} db=${config.mongoDb}`);

  // --vehicle: the owner check, via the exact lookup resolveVehicleOriginalOwner uses.
  if (VEHICLE) {
    const sv = new TurbolySession({ baseUrl: config.turbolyBaseUrl, stateDir: './.turboly-state', userAgentSuffix: 'probe-veh', branchCode: 'PROBE' });
    await sv.start(); await sv.ensureLoggedIn();
    try {
      // Stand on a Turboly page first: right after login the tab can be on
      // about:blank, and a fetch from there is cross-origin and refused.
      await sv.page_().goto(`${config.turbolyBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await sv.page_().waitForTimeout(800);
      const j = (await sv.page_().evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return r.ok ? await r.json() : null; },
        `${config.turbolyBaseUrl}/lookup/vehicles.json?search_term=${encodeURIComponent(VEHICLE)}&page_limit=30&page=1`)) as
        { vehicles?: Array<{ id: number; registration?: string; customer_name?: string; customer_phone?: string }> } | null;
      const norm = (x: string) => (x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rows = (j?.vehicles ?? []).filter((v) => norm(String(v.registration ?? '')) === VEHICLE).sort((a, b) => a.id - b.id);
      console.log(`\n— kendaraan ${VEHICLE} di Turboly → ${rows.length} record —`);
      for (const v of rows) console.log(`  id=${v.id}  plat="${v.registration}"  pemilik="${v.customer_name ?? ''}"  telp=${v.customer_phone ?? '(kosong)'}`);
      if (!rows.length) console.log('  (tidak ada — lookup tidak menemukan plat ini)');
    } finally { await sv.dispose().catch(() => {}); await close().catch(() => {}); }
    process.exit(0);
  }

  // --customers: the duplicate check. Counts the records Turboly holds for one
  // number, which is the only thing that says whether a push ATTACHED to an
  // existing customer or quietly registered a second one.
  if (CUSTOMERS) {
    const key = CUSTOMERS.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    const seen = new Map<number, { name: string; phone: string }>();
    const session0 = new TurbolySession({
      baseUrl: config.turbolyBaseUrl, stateDir: './.turboly-state',
      userAgentSuffix: 'probe-cust', branchCode: 'PROBE',
    });
    await session0.start();
    await session0.ensureLoggedIn();
    const pg = session0.page_();
    try {
      await pg.goto(`${config.turbolyBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(800);
      /**
       * The customers LIST, not lookup/customers.json — the select2 lookup
       * cannot search a phone in any spelling (measured on live, and the same
       * on sandbox: it answered 0 for a number that exists). q[phone_start]
       * normalises server-side, which is why findCustomerByPhoneAnyFormat uses
       * it, so the probe has to ask the same way production does.
       */
      const rows = (await pg.evaluate(async (k) => {
        let res = await fetch('/customers?q%5Bphone_start%5D=' + encodeURIComponent(k), { credentials: 'include' });
        if (!res.ok) res = await fetch('/customers?q%5Bphone_cont%5D=' + encodeURIComponent(k), { credentials: 'include' });
        if (!res.ok) return [];
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const out: Array<{ id: number; cells: string[] }> = [];
        for (const tr of Array.from(doc.querySelectorAll('table tr'))) {
          const a = tr.querySelector('a[href*="/customers/"]');
          if (!a) continue;
          const id = parseInt((a.getAttribute('href') || '').split('/customers/')[1] ?? '', 10);
          if (!id) continue;
          out.push({ id, cells: Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim()).filter(Boolean) });
        }
        return out;
      }, key)) as Array<{ id: number; cells: string[] }>;
      for (const r of rows) {
        const phoneCell = r.cells.find((c) => {
          const d = c.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
          return d === key;
        });
        if (phoneCell) seen.set(r.id, { name: r.cells[0] ?? '', phone: phoneCell });
      }
      console.log(`\n— customer dengan nomor ${CUSTOMERS} (key ${key}) —`);
      for (const [id, c] of seen) console.log(`  id=${id}  "${c.name}"  ${c.phone}`);
      console.log(`  TOTAL: ${seen.size} ${seen.size === 1 ? '→ tidak ada duplikat ✓' : seen.size === 0 ? '→ tidak ditemukan' : '→ DUPLIKAT!'}`);
    } finally {
      await session0.dispose().catch(() => {});
      await close().catch(() => {});
    }
    process.exit(seen.size > 1 ? 1 : 0);
  }

  // 1. What the MIRROR thinks — this is what becomes the search term.
  const mirror = await collections.tbServiceProducts()
    .find({ $or: [{ name: /periodic|maintenance/i }, { _id: /PM|TPI/i }] } as never)
    .toArray().catch(() => []);
  console.log(`\n— mirror (tb_service_products), cocok /periodic|maintenance/ —`);
  if (!mirror.length) console.log('  (tidak ada)');
  for (const p of mirror as Array<Record<string, unknown>>) {
    console.log(`  ${String(p._id).padEnd(20)} "${String(p.name)}"   syncedAt=${String(p.syncedAt ?? '-')}`);
  }

  // 2. What TURBOLY returns, in order. The pusher takes [0].
  const session = new TurbolySession({
    baseUrl: config.turbolyBaseUrl, stateDir: './.turboly-state',
    userAgentSuffix: 'probe-product', branchCode: 'PROBE',
  });
  await session.start();
  await session.ensureLoggedIn();
  const page = session.page_();
  try {
    await page.goto(`${config.turbolyBaseUrl}/service_orders/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const stores = await page.$$eval('#store-id option', (els) =>
      els.map((e) => ({ v: (e as HTMLOptionElement).value, t: (e.textContent ?? '').trim() })).filter((o) => o.v && o.t));
    const store = stores.find((s) => s.t.toUpperCase() === STORE.toUpperCase());
    if (store) { await page.selectOption('#store-id', { value: store.v }); await page.waitForTimeout(2000); }
    console.log(`\nstore: ${store ? `${store.t} (${store.v})` : '(tidak dipilih)'}`);

    // Open the pane exactly as addLinesOnOpenForm does — the add-links sit
    // hidden until this tab is clicked, so the click may no-op but is required.
    await page.getByRole('link', { name: 'Packages, Spareparts & Services' }).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    const addLink = page.locator('a.btn-add-item', { hasText: /add service item/i }).first();
    if (!(await addLink.isVisible().catch(() => false))) {
      await page.locator('.nav-tabs a', { hasText: /packages, spareparts/i }).first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
    if (!(await addLink.isVisible().catch(() => false))) throw new Error('panel "Packages, Spareparts & Services" tidak terbuka');

    for (const q of QUERIES) {
      const rowSel = '.select2-container.input-service-product';
      const before = await page.locator(rowSel).count();
      await page.locator('a.btn-add-item', { hasText: /add service item/i }).first().click();
      for (let i = 0; i < 25 && (await page.locator(rowSel).count()) <= before; i++) await page.waitForTimeout(200);
      await page.waitForTimeout(400);
      await page.locator(rowSel).last().click();
      await page.waitForTimeout(400);
      await page.locator('#select2-drop input.select2-input, .select2-drop-active input.select2-input')
        .first().fill(q).catch(async () => { await page.keyboard.insertText(q); });
      let results: string[] = [];
      for (let i = 0; i < 30; i++) {
        results = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#select2-drop .select2-results li'))
            .filter((x) => !/select2-(no-results|searching|selection-limit|disabled|more-results)/.test(x.className))
            .map((x) => (x as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
        if (results.length) break;
        await page.waitForTimeout(700);
      }
      console.log(`\n— cari "${q}" → ${results.length} hasil —`);
      results.forEach((r, i) => console.log(`  ${i === 0 ? '→ DIPAKAI' : '         '} [${i}] ${r}`));
      if (!results.length) console.log('  (tidak ada hasil)');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    console.log('\n(tidak ada yang disimpan — form tidak pernah di-submit)');
  } finally {
    await session.dispose().catch(() => {});
    await close().catch(() => {});
  }
  process.exit(0);
}
main().catch((e) => { console.error(`\n✗ ${String(e?.message ?? e)}`); process.exit(1); });
