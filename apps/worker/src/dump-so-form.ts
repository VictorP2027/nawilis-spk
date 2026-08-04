import { connect, close } from '@spk/core';
import { writeFileSync } from 'node:fs';
import { config } from './config.js';
const cookiesFrom = (r: Response): string => {
  const g = (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  return (g ? g.call(r.headers) : []).map((c) => c.split(';')[0]).join('; ');
};
async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const base = config.turbolyBaseUrl;
  const p = await fetch(`${base}/users/sign_in`, { redirect: 'manual' });
  let cookie = cookiesFrom(p);
  const tok = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(await p.text())?.[1] ?? '';
  const l = await fetch(`${base}/users/sign_in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ authenticity_token: tok, 'user[email]': process.env.TURBOLY_USERNAME ?? '', 'user[password]': process.env.TURBOLY_PASSWORD ?? '', commit: 'Login' }) });
  cookie = cookiesFrom(l) || cookie;
  const r = await fetch(`${base}/service_orders/new`, { headers: { cookie }, redirect: 'manual' });
  const html = await r.text();
  writeFileSync('/tmp/so-new.html', html);
  console.log(`GET /service_orders/new → ${r.status}, ${html.length} bytes → /tmp/so-new.html`);
  const urls = [...new Set([...html.matchAll(/["'](\/lookup\/[a-z0-9_.\-\/]+)["']/gi)].map((m) => m[1]))];
  console.log('lookup URLs referenced:', JSON.stringify(urls, null, 1));
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
