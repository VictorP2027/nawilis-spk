import { getDb, canonPhoneKey, flowJobs } from '@spk/core';

/**
 * LIVE Turboly customer lookup over plain HTTP (no browser): logs in via the
 * Rails/Devise form flow, caches the session cookie in Mongo, and calls the
 * same JSON endpoint Turboly's own Select2 uses:
 *   GET /lookup/customers.json?search_term=<phone>  → { customers: [ …, vehicles: [...] ] }
 *
 * Session note: Turboly enforces one session per user. Re-login here only
 * happens when the cached cookie is invalid (e.g. after a cron push logged in),
 * and never while a worker holds the session — see workerSessionBusy().
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

/** How long a queued row stays evidence that a worker is actually alive. */
const BUSY_WINDOW_MS = 20 * 60_000;

/**
 * Is a worker holding the shared Turboly session right now?
 *
 * ONE SESSION PER USER: a login from the web app logs the worker out mid-write,
 * and we have watched customer registrations and Service Order saves die
 * half-finished with "You have been logged out". Two queues can have a worker
 * live — the SPK push queue (`spk` queued/pushing) and the board's `flow_jobs`.
 * A `running` job is a browser step executing right now; a `queued` one only
 * counts while recently touched, so an abandoned row can't mute lookups forever.
 * A dedicated TURBOLY_LOOKUP_USERNAME is a separate session and collides with
 * nobody, so the guard is skipped entirely there.
 */
async function workerSessionBusy(): Promise<boolean> {
  if (process.env.TURBOLY_LOOKUP_USERNAME) return false;
  const since = new Date(Date.now() - BUSY_WINDOW_MS).toISOString();
  const [pushing, flowing] = await Promise.all([
    getDb()
      .collection('spk')
      .countDocuments({ state: { $in: ['queued', 'pushing'] }, updatedAt: { $gte: since } }, { limit: 1 }),
    flowJobs().countDocuments(
      {
        $or: [
          // `running` is bounded too: a runner killed mid-job (Actions timeout,
          // crash) leaves the row stuck forever, and an unbounded check would
          // silently degrade every prefill to Mongo until a human noticed.
          { $and: [{ state: 'running' }, { $or: [{ startedAt: { $gte: since } }, { updatedAt: { $gte: since } }] }] },
          { $and: [{ state: 'queued' }, { $or: [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }] }] },
        ],
      },
      { limit: 1 },
    ),
  ]);
  return pushing > 0 || flowing > 0;
}

/**
 * Only a NEW login kicks the worker — replaying the cached cookie does not, so
 * the guard sits here rather than in front of cachedCookie(). Returns null when
 * a worker is busy; callers then report "no live data" instead of throwing, and
 * the API route serves its Mongo fallback rather than an error to the person
 * filling in the form.
 */
async function loginUnlessWorkerBusy(): Promise<string | null> {
  return (await workerSessionBusy()) ? null : login();
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
  // `username` is load-bearing: the worker's session adopter takes this doc
  // only when the label matches ITS user. Now that lookups run as a dedicated
  // account, an unlabelled write would leave the lookup account's cookie under
  // the pusher's old label — and the robot would drive Turboly as the wrong
  // user, resurrecting the very session fight the second account exists to end.
  await getDb().collection('turboly_http_session').updateOne(
    { _id: 'cookie' } as never,
    { $set: { cookie, username: USER, at: new Date().toISOString() } },
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
  steps.push({ step: 'guard', workerBusy: await workerSessionBusy() }); // why a live lookup went quiet
  const url = `${BASE}/lookup/customers.json?search_term=${encodeURIComponent('0' + key)}&page_limit=10&page=1`;
  try {
    const res = await fetch(url, { headers: { cookie: cookie ?? '', accept: 'application/json' }, redirect: 'manual' });
    const text = await res.text();
    steps.push({ step: 'search', status: res.status, ct: res.headers.get('content-type'), loc: res.headers.get('location'), bodyHead: text.slice(0, 200) });
  } catch (e) { steps.push({ step: 'search', error: String(e) }); }
  return steps;
}

export interface TbVehicle {
  registration: string;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  year?: number | string | null;
  color?: string | null;
  customer_id?: number;
  customer_name?: string | null;
  customer_phone?: string | null;
}

/** Find a vehicle (with its owner inline) by exact registration — LIVE from Turboly. */
export async function turbolyVehicleByPlate(plate: string): Promise<TbVehicle | null> {
  const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.length < 4) return null;
  const first = (await cachedCookie()) ?? (await loginUnlessWorkerBusy());
  if (!first) return null; // guard tripped — the route prefills from Mongo instead
  let cookie = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(
      `${BASE}/lookup/vehicles.json?search_term=${encodeURIComponent(key)}&page_limit=10&page=1`,
      { headers: { cookie, accept: 'application/json' }, redirect: 'manual' },
    );
    if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('json')) {
      const j = (await res.json()) as { vehicles?: TbVehicle[] };
      // Duplicate plates are possible (one vehicle row per owner), but THE
      // ORIGINAL registration (lowest id) owns the car — the form prefills the
      // original person, and the push links the SO to them; anyone else
      // bringing the car in is recorded as the carrier in the notes.
      const matches = (j.vehicles ?? []).filter((v) => String(v.registration ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === key);
      return matches.sort((a, b) => ((a as { id?: number }).id ?? 0) - ((b as { id?: number }).id ?? 0))[0] ?? null;
    }
    const fresh = await loginUnlessWorkerBusy();
    if (!fresh) return null; // cached cookie is dead and re-login would kick a worker
    cookie = fresh;
  }
  return null;
}

/**
 * Search Turboly customers by phone; auto re-login once on an invalid session.
 * Turboly's search is PREFIX-based on the stored string, and the same person can
 * exist under different stored forms (0812…, 812…, 62812…, +62812…) — so every
 * variant is queried and results merged. Sorted by id ASC: the lowest id is the
 * oldest registration, and the ORIGINAL record owns the name.
 */
export async function turbolyCustomersByPhone(phone: string): Promise<TbCustomer[]> {
  const key = canonPhoneKey(phone);
  if (key.length < 8) return [];
  const first = (await cachedCookie()) ?? (await loginUnlessWorkerBusy());
  if (!first) return []; // guard tripped — the route prefills from Mongo instead
  let cookie = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    const byId = new Map<number, TbCustomer>();
    let sessionDead = false;
    for (const term of [key, '0' + key, '62' + key, '+62' + key]) {
      const out = await search(term, cookie);
      if (out === null) { // re-login, restart all terms — unless that would kick a worker
        const fresh = await loginUnlessWorkerBusy();
        if (!fresh) return [];
        cookie = fresh;
        sessionDead = true;
        break;
      }
      for (const c of out) {
        if (canonPhoneKey(String(c.phone ?? '')) === key) byId.set(c.id, c);
      }
    }
    if (!sessionDead) return [...byId.values()].sort((a, b) => a.id - b.id);
  }
  return [];
}
