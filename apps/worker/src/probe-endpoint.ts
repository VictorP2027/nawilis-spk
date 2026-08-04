import { connect, close } from '@spk/core';
import { config } from './config.js';

/** Read-only: dump any Turboly endpoint's raw response over HTTP. */
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
  const l = await fetch(`${base}/users/sign_in`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ authenticity_token: tok, 'user[email]': process.env.TURBOLY_USERNAME ?? '', 'user[password]': process.env.TURBOLY_PASSWORD ?? '', commit: 'Login' }),
  });
  cookie = cookiesFrom(l) || cookie;
  for (const path of process.argv.slice(2)) {
    const r = await fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' } });
    cookie = cookiesFrom(r) || cookie;
    const t = await r.text();
    console.log(`\n${path}\n  ${r.status} ${(r.headers.get('content-type') ?? '').split(';')[0]}\n  ${t.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
