import { connect, close } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/** Does Turboly's customer Select2 return results at all in our browser? */
async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const s = new TurbolySession({ baseUrl: config.turbolyBaseUrl, stateDir: config.turbolyStateDir, userAgentSuffix: config.userAgentSuffix, branchCode: 'NWL-BKS' });
  await s.start();
  await s.ensureLoggedIn();
  const page = s.page_();
  page.on('requestfailed', (r) => console.log('REQ FAILED:', r.method(), r.url().slice(0, 110), r.failure()?.errorText));
  await page.goto(`${config.turbolyBaseUrl}/service_orders/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const term = process.argv[2] ?? '081275777757';
  await page.locator('#s2id_select2-input-customer .select2-choice, #s2id_select2-input-customer').first().click();
  await page.waitForTimeout(800);
  const dropInput = page.locator('#select2-drop input').first();
  console.log('drop input visible:', await dropInput.isVisible().catch(() => false));
  await dropInput.type(term, { delay: 30 });
  for (let i = 0; i < 20; i++) {
    const rows = (await page.evaluate(() =>
      Array.from(document.querySelectorAll('#select2-drop .select2-results li')).map((x) => (x as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 90)),
    )) as string[];
    if (rows.length && !rows.some((r) => /searching/i.test(r))) { console.log(`rows after ${i * 400}ms:`, JSON.stringify(rows.slice(0, 5), null, 1)); break; }
    if (i === 19) console.log('TIMED OUT, last rows:', JSON.stringify(rows));
    await page.waitForTimeout(400);
  }
  // The JSON endpoint the widget calls, from inside the page:
  const direct = await page.evaluate(async (t) => {
    const r = await fetch(`/lookup/customers.json?search_term=${encodeURIComponent(t)}&page_limit=5&page=1`, { headers: { accept: 'application/json' } });
    return { status: r.status, ctype: r.headers.get('content-type'), body: (await r.text()).slice(0, 200) };
  }, term);
  console.log('in-page lookup:', JSON.stringify(direct));
  await s.dispose();
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
