import {
  connect, close, collections, emit, getDb,
  flowJobs, completeFlowJob, failFlowJob, ensureFlowIndexes,
  updateFlow, flowPatchAfter, canonPhoneKey, localPhone,
  FLOW_JOB_MAX_ATTEMPTS,
  type FlowActionType, type FlowJob, type SpkDoc,
} from '@spk/core';
import type { Filter } from 'mongodb';
// TYPE-ONLY, and it has to stay that way: `@spk/core/turboly`'s index re-exports
// session.ts, which imports chromium. `import type` is erased at compile time, so
// this line costs nothing at runtime — a value import from the same specifier
// would pull the whole browser stack into a process whose entire point is not
// having one.
import type { HttpRegisterConfig, HttpRegisterResult, HttpRetailArgs, HttpWholesaleArgs } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * BROWSERLESS one-shot drain of flow_jobs — the same claim/execute/complete loop
 * as flow-once.ts, minus Playwright.
 *
 * A registration used to cost ~2 minutes, almost none of it Turboly's fault:
 * 60-90s of runner cold start (npm ci + browser download) and ~25s of form
 * typing, with a restart every time another login kicked the robot mid-form.
 * Registering over HTTP takes 2-3s, so the browser was the entire bill. This
 * runner exists so a registration run never pays it: no browser download, no
 * chromium launch, no page.
 *
 * It handles ONLY the actions with an HTTP implementation (customer
 * registration). Every lifecycle verb is left QUEUED and untouched for
 * flow-once.ts — claiming a job we cannot run and failing it would take work
 * away from the runner that can do it.
 *
 *   node --import tsx apps/worker/src/http-once.ts             # drain all queued
 *   node --import tsx apps/worker/src/http-once.ts --id=01K...  # run one job
 */

const BOOT_AT = Date.now();

/**
 * Shorter than flow-once's 50 minutes on purpose: one HTTP registration is ~3s,
 * so a run still going after 20 minutes is stuck on something, not busy — and
 * the queued jobs it has not reached are better off in the next run (or in the
 * browser runner) than behind a wedged process.
 */
const TIME_BUDGET_MS = 20 * 60_000;

/** The actions this process can execute. Everything else belongs to flow-once. */
type HttpAction = 'register_customer_retail' | 'register_customer_wholesale';
const HTTP_ACTIONS: readonly HttpAction[] = ['register_customer_retail', 'register_customer_wholesale'];

function isHttpAction(v: FlowActionType): v is HttpAction {
  return (HTTP_ACTIONS as readonly string[]).includes(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── errors ─────────────────────────────────────────────────────────────────

/**
 * httpRegister's DataError/TransientError live in rpaSink.ts, which imports
 * session.ts, which imports chromium — importing them for an `instanceof` would
 * undo this file's reason to exist. flow-once already classifies on `e.name`
 * as its fallback, so matching the NAME is what makes these interchangeable
 * with the real ones; the class identity is never checked.
 */
class HttpDataError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DataError';
  }
}
class HttpTransientError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransientError';
  }
}

/**
 * The duplicate check itself is unusable — a 404 on the lookup endpoint, a
 * changed JSON shape. Distinct from both of the above because it is neither
 * "wait and retry" nor "a human must decide": the browser runner reaches these
 * same records a different way, and it is the only path that can still register
 * this customer WITH a duplicate guard in front of it.
 */
class HttpLookupError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LookupError';
  }
}

// ── the runtime half of httpRegister ───────────────────────────────────────

interface RegisterApi {
  registerRetailHttp(cfg: HttpRegisterConfig, args: HttpRetailArgs): Promise<HttpRegisterResult>;
  registerWholesaleHttp(cfg: HttpRegisterConfig, args: HttpWholesaleArgs): Promise<HttpRegisterResult>;
}

let registerApi: RegisterApi | null = null;

/**
 * Deep path, and imported LAZILY, for one reason each.
 *
 * Deep: @spk/core's exports map offers only "." and "./turboly", and "./turboly"
 * is the barrel that re-exports the browser sinks — there is no package-name
 * spelling of this module.
 *
 * Lazy: httpRegister.ts imports DataError/TransientError from rpaSink.ts, so
 * loading it still drags chromium in (measured: 226ms on a warm laptop, more on
 * a cold runner). Deferring it means a run that finds nothing to register never
 * pays that at all, and a run that does pays it once. The import becomes a
 * plain top-level one the day those two error classes move to a leaf module.
 */
async function register(): Promise<RegisterApi> {
  if (!registerApi) {
    const t = Date.now();
    registerApi = await import('../../../packages/core/dist/turboly/httpRegister.js');
    console.log(`http-once: loaded httpRegister in ${Date.now() - t}ms`);
  }
  return registerApi;
}

// ── the shared Turboly HTTP session ────────────────────────────────────────

const SESSION_COLLECTION = 'turboly_http_session';

function cookiesFrom(res: Response): string {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/**
 * ONE SESSION PER USER, so this reads and writes the SAME cookie document
 * httpRegister.ts and the web app's lookup use: a private login here would kick
 * whichever of them is mid-form. The Devise flow is re-implemented rather than
 * imported because httpRegister keeps its login/cookie helpers private — and
 * importing them would mean importing chromium (see register()).
 */
class SharedSession {
  private cookie: string | null = null;

  constructor(private readonly cfg: HttpRegisterConfig) {}

  async get(): Promise<string> {
    if (!this.cookie) this.cookie = (await this.cached()) ?? (await this.login());
    return this.cookie;
  }

  /** Only after a response proved the cookie is dead — a login kicks whoever holds the session. */
  async relogin(): Promise<string> {
    this.cookie = await this.login();
    return this.cookie;
  }

  private async cached(): Promise<string | null> {
    const doc = await getDb().collection(SESSION_COLLECTION).findOne({ _id: 'cookie' } as never);
    return (doc as { cookie?: string } | null)?.cookie ?? null;
  }

  private async login(): Promise<string> {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const r1 = await fetch(`${base}/users/sign_in`, { redirect: 'manual' });
    const pre = cookiesFrom(r1);
    const html = await r1.text();
    const token =
      /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ??
      /csrf-token"[^>]*content="([^"]+)"/.exec(html)?.[1] ??
      '';
    const res = await fetch(`${base}/users/sign_in`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'user[email]': this.cfg.username,
        'user[password]': this.cfg.password,
        authenticity_token: token,
        commit: 'Login',
      }).toString(),
    });
    const cookie = cookiesFrom(res) || pre;
    if (res.status === 302 && cookie) {
      await getDb().collection(SESSION_COLLECTION).updateOne(
        { _id: 'cookie' } as never,
        { $set: { cookie, at: new Date().toISOString() } },
        { upsert: true },
      );
      return cookie;
    }
    if (res.status >= 500) {
      throw new HttpTransientError('Turboly tidak bisa diakses saat login (server error) — dicoba ulang otomatis');
    }
    throw new HttpDataError(`Login Turboly ditolak (HTTP ${res.status}) — periksa kredensial robot`);
  }
}

// ── duplicate guard ────────────────────────────────────────────────────────

interface Hit {
  customerId: string;
  customerUrl: string;
  existing: true;
  note: string;
}

interface LookupRow {
  id: number;
  name: string;
  phone: string | null;
}

/**
 * Turboly's own select2 endpoints, the same ones flowSink's guard uses.
 *
 * A kicked session answers these with the sign-in HTML at HTTP 200, which parses
 * as "no customer found" — that is precisely how the same company got registered
 * twice. So anything that is not a JSON body is a THROW, never an empty result:
 * an unanswered duplicate check must stall the job, not wave a create through.
 */
async function lookupRows(path: string, s: SharedSession, what: string): Promise<LookupRow[]> {
  const base = config.turbolyBaseUrl.replace(/\/+$/, '');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: { cookie: await s.get(), accept: 'application/json' },
    });
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    const bounced = res.status >= 300 && res.status < 400 && /\/users\/sign_in/.test(res.headers.get('location') ?? '');
    if (bounced || (res.status === 200 && !ctype.includes('json'))) {
      if (attempt === 2) {
        throw new HttpTransientError(`${what}: sesi Turboly ter-kick saat cek duplikat — dicoba ulang otomatis`);
      }
      await s.relogin();
      continue;
    }
    if (res.status >= 500) {
      throw new HttpTransientError(
        `${what}: Turboly tidak bisa diakses (HTTP ${res.status}) saat cek duplikat — dicoba ulang otomatis`,
      );
    }
    if (res.status !== 200) {
      throw new HttpLookupError(`${what}: endpoint cek duplikat menjawab HTTP ${res.status} — jalur HTTP tidak bisa menjamin anti-duplikat`);
    }
    const json = (await res.json().catch(() => null)) as { customers?: unknown } | null;
    if (!json || !Array.isArray(json.customers)) {
      throw new HttpLookupError(`${what}: jawaban cek duplikat tidak berbentuk { customers: [...] } — jalur HTTP tidak bisa menjamin anti-duplikat`);
    }
    return (json.customers as Array<Record<string, unknown>>)
      .filter((c) => typeof c.id === 'number')
      .map((c) => ({
        id: c.id as number,
        name: typeof c.name === 'string' ? c.name : '',
        phone: typeof c.phone === 'string' ? c.phone : null,
      }));
  }
  throw new HttpTransientError(`${what}: cek duplikat gagal — dicoba ulang otomatis`);
}

function customerUrl(id: number | string): string {
  return `${config.turbolyBaseUrl.replace(/\/+$/, '')}/customers/${id}`;
}

/**
 * A customer registered without a phone got NO duplicate check — the only key
 * Turboly's search is reliable on is the phone, and names repeat. Say so on the
 * job so the operator knows this one record was created unguarded.
 */
function withGuardNote(note: string, phone: string): string {
  return canonPhoneKey(phone).length >= 8 ? note : `${note} • tanpa nomor HP: guard duplikat tidak bisa dijalankan`;
}

/**
 * An existing customer with EXACTLY this phone. Turboly's search is a PREFIX
 * match on the stored string, so a record saved as "+62812…" is invisible to a
 * search for "0812…" — every spelling is queried and the comparison is made on
 * the canonical key, which is what a "0…" vs "+62…" split cost us once already.
 */
async function findCustomerByPhone(phone: string, s: SharedSession, what: string): Promise<Hit | null> {
  const key = canonPhoneKey(phone);
  if (key.length < 8) return null; // no phone = nothing to match on; the name is not unique enough to guard with (see withGuardNote)
  for (const term of [key, `0${key}`, `62${key}`, `+62${key}`]) {
    const rows = await lookupRows(`/lookup/customers.json?search_term=${encodeURIComponent(term)}&page_limit=10&page=1`, s, what);
    const hit = rows.find((c) => canonPhoneKey(c.phone ?? '') === key);
    if (hit) {
      return {
        customerId: String(hit.id),
        customerUrl: customerUrl(hit.id),
        existing: true,
        note: `customer dengan nomor HP ini sudah terdaftar (${hit.name || 'tanpa nama'}) — tidak dibuat ulang (guard duplikat)`,
      };
    }
  }
  return null;
}

/**
 * An existing WHOLESALE company with exactly this name. Companies share the
 * /customers/<id> URL space with retail customers, so the list page cannot be
 * scraped for them — their select2 endpoint is the only authoritative answer.
 * On a duplicate name the LOWEST id is the original.
 */
async function findCompanyByName(name: string, s: SharedSession, what: string): Promise<Hit | null> {
  const want = name.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!want) return null;
  const rows = await lookupRows(
    `/lookup/wholesale_customers.json?search_term=${encodeURIComponent(name.trim())}&page_limit=20&page=1`,
    s,
    what,
  );
  const hits = rows.filter((c) => c.name.trim().toUpperCase().replace(/\s+/g, ' ') === want).sort((a, b) => a.id - b.id);
  const hit = hits[0];
  if (!hit) return null;
  return {
    customerId: String(hit.id),
    customerUrl: customerUrl(hit.id),
    existing: true,
    note:
      hits.length > 1
        ? `perusahaan "${name.trim()}" ada ${hits.length}× di Turboly — dipakai yang paling awal (id ${hit.id}), tidak dibuat ulang`
        : `perusahaan "${name.trim()}" sudah terdaftar — tidak dibuat ulang (guard duplikat)`,
  };
}

/**
 * Failures httpRegister raises while BUILDING the request — our reading of the
 * form was wrong, so nothing was posted and the browser (which runs the page's
 * own JS) may well succeed. Copied from flowSink's HTTP_FORM_UNREADABLE because
 * that list is not exported; it must stay in sync, and nothing raised AFTER the
 * POST ("… ditolak Turboly", "simpan tidak terkonfirmasi") may ever join it —
 * every entry here is used as PROOF that no record was created.
 */
const FORM_UNREADABLE: RegExp[] = [
  /form customer tidak ada/i,
  /authenticity_token tidak ada/i,
  /template baris alamat/i,
  /kontrol .{0,40} tidak ada di form/i,
  /SALES TAX tidak bisa diset ke PPN/i,
  /Pilihan:\s*\(kosong\)/i,
  /Login Turboly ditolak|Kredensial Turboly belum diisi/i,
];

function isPreWriteFailure(e: unknown): boolean {
  const msg = msgOf(e);
  return (e instanceof Error ? e.name : '') === 'DataError' && FORM_UNREADABLE.some((re) => re.test(msg));
}

/**
 * The one place a record is created. On ANY failure the lookup is re-run before
 * the error escapes, because a socket that dies AFTER the POST is
 * indistinguishable from one that dies before it — and whatever the caller does
 * next (requeue, or hand the job to the browser runner) would create the second
 * record. Duplicate customers are this system's worst failure mode; a stalled
 * job is not.
 */
async function createOnce(
  what: string,
  create: () => Promise<HttpRegisterResult>,
  lookup: () => Promise<Hit | null>,
): Promise<{ customerId: string | null; customerUrl: string; existing: boolean; note: string }> {
  try {
    const r = await create();
    return { customerId: r.customerId, customerUrl: r.customerUrl, existing: false, note: 'didaftarkan lewat jalur cepat (HTTP)' };
  } catch (e) {
    const after = await lookup().catch(() => 'unreadable' as const);
    if (after && after !== 'unreadable') {
      return { ...after, note: `${after.note} • percobaan sebelumnya ternyata sudah tersimpan` };
    }
    // Save unconfirmed AND the duplicate check unavailable: there is no evidence
    // either way, so this must reach a human rather than any retry path.
    if (after === 'unreadable' && !isPreWriteFailure(e)) {
      throw new HttpDataError(
        `${what}: hasil simpan TIDAK PASTI dan cek duplikat juga gagal — periksa Turboly dulu sebelum mendaftarkan ulang (${msgOf(e)})`,
      );
    }
    throw e;
  }
}

// ── per-action executor ────────────────────────────────────────────────────

type FlowDoc = SpkDoc & { flow?: unknown };

function httpConfig(): HttpRegisterConfig {
  // The per-branch encrypted credential is only decryptable through session.ts
  // (chromium), so this uses the env pair — which is what every branch logs in
  // with today anyway, one session per user being the whole constraint.
  const username = process.env.TURBOLY_USERNAME ?? '';
  const password = process.env.TURBOLY_PASSWORD ?? '';
  if (!username || !password) {
    throw new HttpDataError(
      'Kredensial Turboly belum diisi (TURBOLY_USERNAME/TURBOLY_PASSWORD kosong) — jalur HTTP tidak bisa login',
    );
  }
  return { baseUrl: config.turbolyBaseUrl, username, password };
}

async function executeJob(
  job: FlowJob,
  action: HttpAction,
  p: Record<string, unknown>,
  s: SharedSession,
  cfg: HttpRegisterConfig,
): Promise<Record<string, unknown>> {
  const doc = job.spkId ? ((await collections.spk().findOne({ _id: job.spkId })) as FlowDoc | null) : null;
  if (job.spkId && !doc) throw new HttpDataError(`Dokumen ${job.spkId} tidak ditemukan di Mongo`);

  const branchCode = doc?.branchCode ?? str(p.branchCode) ?? str(p.storeCode) ?? '';
  if (!branchCode) throw new HttpDataError('branchCode tidak ada — sertakan params.branchCode untuk registrasi customer');

  const api = await register();

  if (action === 'register_customer_retail') {
    const what = 'Customer Retail';
    const nama = str(p.nama) ?? str(p.name);
    if (!nama) throw new HttpDataError('Nama customer (params.nama) wajib');
    // Store the LOCAL 0… spelling: Turboly's search is a prefix match on the
    // stored string, so an E.164 record and a 0… record never find each other.
    const phone = localPhone(str(p.phone) ?? str(p.wa) ?? '');
    const dup = await findCustomerByPhone(phone, s, what);
    if (dup) return { ...dup };

    let storeTurbolyId = str(p.storeTurbolyId);
    if (!storeTurbolyId) storeTurbolyId = (await collections.tbStores().findOne({ _id: branchCode }))?.turbolyStoreId ?? null;

    const r = await createOnce(
      what,
      () =>
        api.registerRetailHttp(cfg, {
          nama,
          phone,
          alamat: str(p.alamat) ?? str(p.address) ?? '',
          storeTurbolyId,
          companyName: str(p.companyName),
          companyId: str(p.companyId),
        }),
      () => findCustomerByPhone(phone, s, what),
    );
    return { ...r, note: withGuardNote(r.note, phone) };
  }

  const what = 'Customer Wholesale';
  const companyName = str(p.companyName) ?? str(p.company);
  if (!companyName) throw new HttpDataError('Nama perusahaan (params.companyName) wajib');

  const rp = (p.retail && typeof p.retail === 'object' ? p.retail : {}) as Record<string, unknown>;
  const retailNama = str(rp.nama) ?? str(rp.name) ?? str(p.nama) ?? str(p.name);
  let storeTurbolyId = str(rp.storeTurbolyId) ?? str(p.storeTurbolyId);
  if (retailNama && !storeTurbolyId) {
    storeTurbolyId = (await collections.tbStores().findOne({ _id: branchCode }))?.turbolyStoreId ?? null;
  }

  // Two-step with the SAME job-row checkpoint flow-once writes: the company save
  // is irreversible, so a retry after a failed retail half must not create it
  // again. Read by both runners, so a job that changes hands mid-flight is safe.
  type WholesaleProgress = { companyId?: string | null; companyUrl?: string | null };
  const prog = (job as FlowJob & { progress?: WholesaleProgress | null }).progress ?? null;
  let companyId: string | null;
  let companyUrl: string;
  let note: string | null = null;
  if (prog?.companyUrl) {
    companyId = prog.companyId ?? null;
    companyUrl = prog.companyUrl;
    note = 'perusahaan sudah dibuat pada percobaan sebelumnya (checkpoint) — tidak dibuat ulang';
  } else {
    const dupCo = await findCompanyByName(companyName, s, what);
    const w =
      dupCo ??
      (await createOnce(
        what,
        () =>
          api.registerWholesaleHttp(cfg, {
            companyName,
            picName: str(p.picName) ?? str(p.pic) ?? '',
            npwp: str(p.npwp) ?? '',
            alamat: str(p.alamat) ?? str(p.address) ?? '',
            advisorName: str(p.advisorName) ?? str(p.advisor) ?? '',
          }),
        () => findCompanyByName(companyName, s, what),
      ));
    companyId = w.customerId;
    companyUrl = w.customerUrl;
    note = w.note;
    await flowJobs().updateOne(
      { _id: job._id },
      { $set: { progress: { companyId, companyUrl }, updatedAt: new Date().toISOString() } as unknown as Partial<FlowJob> },
    );
  }

  let retail: Record<string, unknown> | null = null;
  if (retailNama) {
    const phone = localPhone(str(rp.phone) ?? str(rp.wa) ?? str(p.phone) ?? str(p.wa) ?? '');
    const dup = await findCustomerByPhone(phone, s, 'Customer Retail');
    if (dup) {
      retail = { ...dup };
    } else {
      const r = await createOnce(
        'Customer Retail',
        () =>
          api.registerRetailHttp(cfg, {
            nama: retailNama,
            phone,
            alamat: str(rp.alamat) ?? str(p.alamat) ?? str(p.address) ?? '',
            storeTurbolyId,
            companyName,
            // Link by id, not by visible name: two companies can share a name
            // and the browser path can only pick text.
            companyId,
          }),
        () => findCustomerByPhone(phone, s, 'Customer Retail'),
      );
      retail = { ...r, note: withGuardNote(r.note, phone) };
    }
  }
  return { companyId, companyUrl, ...(retail ? { retail } : {}), ...(note ? { note } : {}) };
}

// ── failure disposition ────────────────────────────────────────────────────

type Disposition = 'transient' | 'browser' | 'permanent';

/**
 * flow-once's classify(), plus the outcome a browserless runner has and it does
 * not: handing the job BACK. 'browser' means "nothing was written and the page's
 * own JS might succeed where our HTML scraping did not" — the browser runner
 * gets the job untouched instead of an operator getting a review ticket.
 */
function disposition(e: unknown): { d: Disposition; msg: string } {
  const msg = msgOf(e);
  const name = e instanceof Error ? e.name : '';
  if (/site maintenance|undergoing scheduled upgrades|logged out\. please login/i.test(msg)) {
    return { d: 'transient', msg: 'Turboly sedang MAINTENANCE (upgrade terjadwal) — otomatis dilanjutkan setelah Turboly online lagi.' };
  }
  if (name === 'TransientError' || name === 'LeaseLostError') return { d: 'transient', msg };
  if (name === 'LookupError') return { d: 'browser', msg };
  if (name === 'AuthChallengeError') {
    return { d: 'permanent', msg: `Login Turboly gagal — jalankan npm run login:turboly. (${msg})` };
  }
  if (name === 'DataError') {
    // Turboly rejected our VALUES: the browser posts the same values and gets
    // the same rejection, so only the pre-POST parse failures hand over.
    return { d: isPreWriteFailure(e) ? 'browser' : 'permanent', msg };
  }
  if (/timeout|timed out|net::|ERR_|fetch failed|socket|econnreset/i.test(msg)) return { d: 'transient', msg };
  // Unclassified — a TypeError out of the HTML scanning, a dead socket. createOnce
  // has already proven no record was created (or converted this into a permanent
  // DataError), so the browser can safely take it.
  return { d: 'browser', msg };
}

// ── claim / drain loop ─────────────────────────────────────────────────────

/**
 * CAS claim (queued → running) pinned to the actions this process implements.
 * The action filter is the whole safety property: a lifecycle job is never even
 * momentarily ours, so flow-once's next claim still finds it queued.
 */
async function claimJob(onlyId: string | undefined): Promise<FlowJob | null> {
  const now = new Date().toISOString();
  const filter: Filter<FlowJob> = {
    state: 'queued',
    action: { $in: [...HTTP_ACTIONS] },
    // Set by releaseToBrowser. Without it the handed-over job is still queued
    // and still a registration, so the next http-once run would claim it, fail
    // the same way and hand it over again — a GET storm that never ends.
    httpHandover: { $ne: true },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }],
  } as Filter<FlowJob>;
  if (onlyId) filter._id = onlyId;
  const res = await flowJobs().findOneAndUpdate(
    filter,
    { $set: { state: 'running', startedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  return res ?? null;
}

/**
 * Put the job back for flow-once, exactly as it was found. The attempt is given
 * back too: our failed HTTP read is not one of the browser's five tries, and
 * spending them here would retire a job the browser never touched.
 */
async function releaseToBrowser(job: FlowJob, why: string): Promise<void> {
  const now = new Date().toISOString();
  await flowJobs().updateOne(
    { _id: job._id, state: 'running' },
    {
      $set: { state: 'queued' as const, nextAttemptAt: null, error: why, updatedAt: now, httpHandover: true },
      $inc: { attempts: -1 },
    } as never,
  );
}

async function main(): Promise<void> {
  const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5);

  // The same kill switch flowSink honours. Off means every registration belongs
  // to the browser, so this process must not claim a single one of them.
  if (['0', 'off', 'false', 'no'].includes((process.env.TURBOLY_HTTP_REGISTER ?? '').trim().toLowerCase())) {
    console.log('http-once: TURBOLY_HTTP_REGISTER is off — leaving every job for the browser runner');
    process.exit(0);
  }

  // Nothing has been claimed at this point, so bailing here leaves every job for
  // the browser runner. Exit NON-zero anyway: a browserless runner that quietly
  // does nothing every hour is indistinguishable from one that is working.
  let cfg: HttpRegisterConfig;
  try {
    cfg = httpConfig();
  } catch (e) {
    console.error(`http-once: ${msgOf(e)} — every job left for the browser runner`);
    process.exit(1);
  }

  await connect(config.mongoUri, config.mongoDb);
  await ensureFlowIndexes();
  console.log(`http-once: base=${config.turbolyBaseUrl} ready in ${Date.now() - BOOT_AT}ms (no browser)`);

  const session = new SharedSession(cfg);

  let done = 0;
  let failed = 0;
  let requeued = 0;
  let released = 0;
  const startedAt = Date.now();

  try {
    for (;;) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        console.log('http-once: time budget reached — exiting (the next run resumes)');
        break;
      }
      const job = await claimJob(onlyId);
      if (!job) break;
      const claimedAt = Date.now();
      const label = `${String(job.action)} spk=${job.spkId || '-'} job=${job._id} attempt=${job.attempts}`;
      console.log(`http-once: run ${label}`);

      // Belt-and-braces on the claim filter: running a job whose action we do not
      // implement would mean firing a CUSTOMER CREATE at a lifecycle job, which
      // is unrecoverable. Hand it straight back — never fail it.
      if (!isHttpAction(job.action)) {
        await releaseToBrowser(job, `aksi ${String(job.action)} bukan jalur HTTP — dikembalikan untuk robot browser`);
        released += 1;
        console.error(`http-once: HANDOVER ${label} — not an HTTP action`);
        if (onlyId) break;
        continue;
      }

      try {
        const params = (job.params ?? {}) as Record<string, unknown>;
        const result = await executeJob(job, job.action, params, session, cfg);

        if (job.spkId && result.alreadyDone !== true) {
          const patch = flowPatchAfter(job.action, { ...params, ...result }, result);
          if (Object.keys(patch).length) await updateFlow(job.spkId, patch);
        }

        await completeFlowJob(job._id, result);
        if (job.spkId) await emit({ spkId: job.spkId, type: `flow_${job.action}_done`, by: job.by ?? 'http-worker', data: result });
        done += 1;
        console.log(`http-once: ok ${label} — ${Date.now() - claimedAt}ms`);
      } catch (e) {
        const { d, msg } = disposition(e);
        if (d === 'browser') {
          const why = `jalur cepat (HTTP) tidak bisa menyelesaikan ini (${msg}) — dikembalikan ke antrean untuk robot browser`;
          await releaseToBrowser(job, why);
          released += 1;
          console.error(`http-once: HANDOVER ${label} — ${msg} (${Date.now() - claimedAt}ms)`);
        } else {
          const transient = d === 'transient';
          const willRetry = transient && job.attempts < (job.maxAttempts ?? FLOW_JOB_MAX_ATTEMPTS);
          await failFlowJob(job._id, msg, { transient });
          if (job.spkId) {
            const ts = new Date().toISOString();
            await collections.spk().updateOne({ _id: job.spkId }, { $set: { 'flow.lastError': msg, 'flow.lastErrorAt': ts, updatedAt: ts } });
          }
          if (willRetry) requeued += 1;
          else failed += 1;
          console.error(`http-once: FAIL(${transient ? 'transient' : 'permanent'}) ${label} — ${msg} (${Date.now() - claimedAt}ms)`);
        }
      }

      if (onlyId) break;
    }
  } finally {
    await close();
  }

  console.log(
    `http-once: ${done} done, ${requeued} requeued (transient), ${released} handed to browser, ${failed} failed — ${Date.now() - BOOT_AT}ms total`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
