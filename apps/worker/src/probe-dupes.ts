import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/** How many customers/companies match these search terms in Turboly? */
async function main(): Promise<void> {
  const terms = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const s = new TurbolySession({
    baseUrl: config.turbolyBaseUrl,
    stateDir: config.turbolyStateDir,
    userAgentSuffix: config.userAgentSuffix,
    branchCode: 'NWL-BKS',
  });
  await s.start();
  await s.ensureLoggedIn();
  const page = s.page_();
  for (const t of terms) {
    for (const path of ['/lookup/customers.json', '/lookup/customer_wholesales.json', '/lookup/wholesale_customers.json']) {
      const res = await page.request
        .get(`${config.turbolyBaseUrl}${path}?search_term=${encodeURIComponent(t)}&page_limit=20&page=1`, { headers: { accept: 'application/json' } })
        .catch(() => null);
      if (!res) { console.log(`${path} "${t}" → (request failed)`); continue; }
      const ctype = (res.headers()['content-type'] ?? '').split(';')[0];
      let body = '';
      try { body = (await res.text()).slice(0, 700); } catch { body = '(unreadable)'; }
      console.log(`\n${path} "${t}" → ${res.status()} ${ctype}\n  ${body.replace(/\s+/g, ' ')}`);
    }
  }
  await s.dispose();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
