import { connect, close } from '@spk/core';
import { config } from './config.js';

/** Read-only Turboly lookup over plain HTTP (no browser, no session cost). */
const cookiesFrom = (res: Response): string => {
  const gsc = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  return (gsc ? gsc.call(res.headers) : []).map((c) => c.split(';')[0]).join('; ');
};

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const base = config.turbolyBaseUrl;
  const page = await fetch(`${base}/users/sign_in`, { redirect: 'manual' });
  let cookie = cookiesFrom(page);
  const html = await page.text();
  const token = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? '';
  const login = await fetch(`${base}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ authenticity_token: token, 'user[email]': process.env.TURBOLY_USERNAME ?? '', 'user[password]': process.env.TURBOLY_PASSWORD ?? '', commit: 'Login' }),
  });
  cookie = cookiesFrom(login) || cookie;
  for (const term of process.argv.slice(2)) {
    for (const p of ['/lookup/wholesale_customers.json', '/lookup/customers.json']) {
      const r = await fetch(`${base}${p}?search_term=${encodeURIComponent(term)}&page_limit=20&page=1`, { headers: { cookie, accept: 'application/json' } });
      const t = await r.text();
      console.log(`${p} "${term}" → ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
