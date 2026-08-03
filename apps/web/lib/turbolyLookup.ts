import { getDb, canonPhoneKey } from '@spk/core';

/**
 * LIVE Turboly customer lookup over plain HTTP (no browser): logs in via the
 * Rails/Devise form flow, caches the session cookie in Mongo, and calls the
 * same JSON endpoint Turboly's own Select2 uses:
 *   GET /lookup/customers.json?search_term=<phone>  → { customers: [ …, vehicles: [...] ] }
 *
 * Session note: Turboly enforces one session per user. Re-login here only
 * happens when the cached cookie is invalid (e.g. after a cron push logged in).
 * For zero interference, set TURBOLY_LOOKUP_USERNAME/PASSWORD to a dedicated
 * second Turboly user; otherwise the main credentials are used.
 */
const BASE = process.env.TURBOLY_BASE_URL ?? 'https://sandbox.turboly.com';
const USER = process.env.TURBOLY_LOOKUP_USERNAME ?? process.env.TURBOLY_USERNAME ?? '';
const PASS = process.env.TURBOLY_LOOKUP_PASSWORD ?? process.env.TURBOLY_PASSWORD ?? '';

interface TbCustomer {
  id: number;
  name: string;
  address?: string | null;
  phone?: string | null;
  vehicles?: Array<Record<string, unknown>>;
}

function cookiesFrom(res: Response): string {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function login(): Promise<string> {
  if (!USER || !PASS) throw new Error('no Turboly credentials configured');
  const r1 = await fetch(`${BASE}/users/sign_in`, { redirect: 'manual' });
  const pre = cookiesFrom(r1);
  const html = await r1.text();
  const token =
    /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ??
    /csrf-token"[^>]*content="([^"]+)"/.exec(html)?.[1] ?? '';
  const body = new URLSearchParams({
    'user[email]': USER,
    'user[password]': PASS,
    authenticity_token: token,
    commit: 'Login',
  });
  const r2 = await fetch(`${BASE}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const cookie = cookiesFrom(r2) || pre;
  if (!cookie || r2.status !== 302) throw new Error(`Turboly login failed (${r2.status})`);
  await getDb().collection('turboly_http_session').updateOne(
    { _id: 'cookie' } as never,
    { $set: { cookie, at: new Date().toISOString() } },
    { upsert: true },
  );
  return cookie;
}

async function cachedCookie(): Promise<string | null> {
  const doc = await getDb().collection('turboly_http_session').findOne({ _id: 'cookie' } as never);
  return (doc as { cookie?: string } | null)?.cookie ?? null;
}

async function search(term: string, cookie: string): Promise<TbCustomer[] | null> {
  const res = await fetch(
    `${BASE}/lookup/customers.json?search_term=${encodeURIComponent(term)}&page_limit=10&page=1`,
    { headers: { cookie, accept: 'application/json' }, redirect: 'manual' },
  );
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json')) return null; // kicked/expired
  const j = (await res.json()) as { customers?: TbCustomer[] };
  return j.customers ?? [];
}

/** Diagnostic: raw statuses at each step, as seen from THIS server. */
export async function turbolyDebugProbe(phone: string): Promise<unknown> {
  const key = canonPhoneKey(phone);
  const steps: unknown[] = [];
  const cookie = await cachedCookie();
  steps.push({ step: 'cachedCookie', present: !!cookie, len: cookie?.length ?? 0 });
  const url = `${BASE}/lookup/customers.json?search_term=${encodeURIComponent('0' + key)}&page_limit=10&page=1`;
  try {
    const res = await fetch(url, { headers: { cookie: cookie ?? '', accept: 'application/json' }, redirect: 'manual' });
    const text = await res.text();
    steps.push({ step: 'search', status: res.status, ct: res.headers.get('content-type'), loc: res.headers.get('location'), bodyHead: text.slice(0, 200) });
  } catch (e) { steps.push({ step: 'search', error: String(e) }); }
  return steps;
}

/** Search Turboly customers by phone; auto re-login once on an invalid session. */
export async function turbolyCustomersByPhone(phone: string): Promise<TbCustomer[]> {
  const key = canonPhoneKey(phone);
  if (key.length < 8) return [];
  let cookie = (await cachedCookie()) ?? (await login());
  for (let attempt = 0; attempt < 2; attempt++) {
    // Try local 0-form first (Turboly's common stored form), then the bare key.
    for (const term of ['0' + key, key]) {
      const out = await search(term, cookie);
      if (out === null) { cookie = await login(); break; } // session invalid → re-login, retry
      const hits = out.filter((c) => canonPhoneKey(String(c.phone ?? '')) === key);
      if (hits.length) return hits;
      if (term === key) return []; // both forms tried, genuinely no match
    }
  }
  return [];
}
