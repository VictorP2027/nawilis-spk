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
const QUERIES = (arg('q') ?? 'Periodic Maintenance|TPI-NAWJAS-PM').split('|').map((s) => s.trim()).filter(Boolean);
const STORE = arg('store') ?? 'Nawilis Bekasi';

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  console.log(`base=${config.turbolyBaseUrl} db=${config.mongoDb}`);

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

    for (const q of QUERIES) {
      const rowSel = '.select2-container.input-service-product';
      const before = await page.locator(rowSel).count();
      await page.locator('a.btn-add-item', { hasText: /add service item/i }).first().click();
      for (let i = 0; i < 25 && (await page.locator(rowSel).count()) <= before; i++) await page.waitForTimeout(200);
      await page.waitForTimeout(400);
      await page.locator(rowSel).last().click();
      await page.waitForTimeout(400);
      await page.keyboard.insertText(q);
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
