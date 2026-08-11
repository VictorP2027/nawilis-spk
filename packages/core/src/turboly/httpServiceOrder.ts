import { getDb } from '../mongo.js';
import { canonPhoneKey, localPhone } from '../indonesia.js';
import { DataError, TransientError, NeedAddVehicleError } from './rpaSink.js';
import type { TurbolyServiceOrderPayload } from './sink.js';

/**
 * Service Order over plain HTTP — the seconds-not-minutes twin of
 * httpRegister.ts, for the write rpaSink.buildAndSaveOrder does in a browser.
 *
 * Why it exists: the browser build spends ~25s of fixed waits per order and
 * holds Turboly's SINGLE session open for all of it, so any other login (a
 * human, the hourly catalog sync, the web app's prefill) kicks it mid-form and
 * the whole order restarts from zero. GET the form, echo back every control it
 * contains, override the fields we own, POST once: two round trips, and a
 * collision window roughly 20x smaller.
 *
 * Scope, deliberately: no approve (the caller owns DRAFT→APPROVED), no customer
 * create (httpRegister.ts), no vehicle create — a missing vehicle raises
 * NeedAddVehicleError so the caller creates it and re-runs this.
 *
 * Ids, not names: customer/vehicle/service pickers are Select2 widgets over
 * hidden inputs, so what actually posts is a numeric id. Those are resolved
 * from the same /lookup/*.json endpoints Select2 itself calls, under the RPA's
 * identity rules — phone is the person, lowest id is the original record, and a
 * half-answered lookup is never an answer about the data.
 */

const WHAT = 'Service Order';

type ServiceLine = TurbolyServiceOrderPayload['serviceLines'][number];

export interface HttpServiceOrderConfig {
  baseUrl: string;
  /**
   * An already-established session cookie. Preferred over credentials: ONE
   * SESSION PER USER means a fresh login here kicks whoever currently holds it.
   */
  cookie?: string;
  username?: string;
  password?: string;
  /** Skip the id lookups when the caller already resolved them. */
  customerId?: string;
  vehicleId?: string;
  /**
   * Option values of #service-advisor-id / #salesperson-id. The form loads the
   * store's user list by AJAX after the store is picked, so the HTML we fetch
   * may not contain it at all — tb_mechanics.mechanicCode already holds exactly
   * these values (sync-catalogs.mjs reads them off those same selects).
   */
  serviceAdvisorId?: string;
  salespersonId?: string;
  /**
   * Escape hatch for the one id with no documented lookup endpoint: the service
   * product. Return null to fall back to endpoint discovery.
   */
  resolveProductId?: (line: ServiceLine) => Promise<string | null> | string | null;
}

export interface HttpServiceOrderResult {
  /** Turboly's generated document number (SRO/BKS/…), null when unreadable — never a reason to retry. */
  serviceOrderNo: string | null;
  serviceOrderUrl: string;
  serviceOrderId: string;
  /** Non-fatal things the operator should see (carrier note, missing price). */
  warnings: string[];
}

export interface ServiceOrderParties {
  customerId: string;
  vehicleId: string;
  ownerName: string;
  ownerPhone: string;
  /** Set when the person who brought the car is not the registered owner. */
  carrierNote: string | null;
}

/**
 * The HTML scanning below is a deliberate copy of httpRegister.ts's parser —
 * that module exports none of it. Unify them once both have run live; a shared
 * edit today would put the already-working customer path at risk. Same
 * constraint holds: Rails escapes quotes and angle brackets inside attribute
 * values, so no tag body contains a raw '>' and [^>]* is safe.
 */

type Attrs = Record<string, string>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', hellip: '…',
};

/** Run once per nesting level — insertion templates arrive escaped TWICE (HTML inside an attribute). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const n = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (ent.startsWith('#')) {
      const n = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

/** Attributes of one open tag. A valueless attribute (checked, selected) maps to ''. */
function attrsOf(tagBody: string): Attrs {
  const out: Attrs = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tagBody)) !== null) {
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    out[(m[1] ?? '').toLowerCase()] = decodeEntities(raw);
  }
  return out;
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Comparison key for option labels: case- and space-insensitive. */
function normText(s: string): string {
  return collapse(stripTags(s)).toLowerCase();
}

function normPlate(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface ParsedOption { value: string; text: string; selected: boolean; disabled: boolean }

function optionsOf(inner: string): ParsedOption[] {
  const out: ParsedOption[] = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const a = attrsOf(m[1] ?? '');
    const text = collapse(stripTags(m[2] ?? ''));
    out.push({
      // HTML says an option with no value attribute submits its own text.
      value: 'value' in a ? (a['value'] ?? '') : text,
      text,
      selected: 'selected' in a,
      disabled: 'disabled' in a,
    });
  }
  return out;
}

interface Ctl { kind: 'input' | 'select' | 'textarea'; attrs: Attrs; inner: string }

/** Controls in DOCUMENT ORDER — order carries meaning (Rails' hidden checkbox companions). */
function controlsIn(fragment: string): Ctl[] {
  const out: Ctl[] = [];
  const re = /<(input|select|textarea)\b([^>]*)>/gi;
  const lower = fragment.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const kind = (m[1] ?? '').toLowerCase() as Ctl['kind'];
    const attrs = attrsOf(m[2] ?? '');
    if (kind === 'input') {
      out.push({ kind, attrs, inner: '' });
      continue;
    }
    const close = lower.indexOf(`</${kind}>`, re.lastIndex);
    const inner = close === -1 ? '' : fragment.slice(re.lastIndex, close);
    out.push({ kind, attrs, inner });
    // Options and textarea text hold no further controls; skipping past them keeps
    // a stray "<input" inside placeholder text from being submitted.
    if (close !== -1) re.lastIndex = close + kind.length + 3;
  }
  return out;
}

/**
 * Seed the POST body with what a browser would send for this exact form, then
 * override only what we own. Echoing beats a hardcoded field map: Turboly can
 * add, rename or reorder hidden fields and this still posts them.
 */
function bodyFromControls(controls: Ctl[]): URLSearchParams {
  const body = new URLSearchParams();
  for (const c of controls) {
    const name = c.attrs['name'];
    if (!name) continue;
    if ('disabled' in c.attrs) continue; // browsers never submit a disabled control
    if (c.kind === 'textarea') {
      body.append(name, decodeEntities(c.inner).replace(/^\r?\n/, ''));
      continue;
    }
    if (c.kind === 'select') {
      const opts = optionsOf(c.inner);
      if ('multiple' in c.attrs) {
        for (const o of opts) if (o.selected && !o.disabled) body.append(name, o.value);
        continue;
      }
      // No option marked selected → the browser selects the first enabled one.
      const chosen = opts.filter((o) => o.selected && !o.disabled).pop() ?? opts.find((o) => !o.disabled);
      if (chosen) body.append(name, chosen.value);
      continue;
    }
    const type = (c.attrs['type'] ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') continue;
    if ((type === 'checkbox' || type === 'radio') && !('checked' in c.attrs)) continue;
    body.append(name, c.attrs['value'] ?? (type === 'checkbox' || type === 'radio' ? 'on' : ''));
  }
  return body;
}

/**
 * The Save button, mirrored the way a click would send it. Some Rails
 * controllers branch on params[:commit] ("Save" vs "Save & Approve"), and this
 * must never post the approving one — approve is not ours to do here.
 */
function saveSubmit(fragment: string): { name: string; value: string } | null {
  const found: Array<{ name: string; value: string }> = [];
  for (const c of controlsIn(fragment)) {
    if (c.kind !== 'input') continue;
    if ((c.attrs['type'] ?? '').toLowerCase() !== 'submit') continue;
    const name = c.attrs['name'];
    if (name) found.push({ name, value: c.attrs['value'] ?? '' });
  }
  const buttons = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m: RegExpExecArray | null;
  while ((m = buttons.exec(fragment)) !== null) {
    const a = attrsOf(m[1] ?? '');
    const type = (a['type'] ?? 'submit').toLowerCase();
    if (type !== 'submit' || !a['name']) continue;
    found.push({ name: a['name'], value: a['value'] ?? collapse(stripTags(m[2] ?? '')) });
  }
  if (found.length === 1) return found[0] ?? null;
  return found.find((f) => /^save$|^simpan$/i.test(f.value.trim())) ?? null;
}

function absUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

interface OrderForm {
  /** Whole page — insertion-template anchors can sit outside the <form>. */
  page: string;
  region: string;
  actionUrl: string;
  body: URLSearchParams;
  controls: Ctl[];
}

/**
 * Pick the Service Order <form>. Scored by how many service_order[...] controls
 * each form region holds rather than by action/id: the page also carries the
 * global search, sign-out and filter forms, and modals bring their own.
 */
function serviceOrderFormOf(page: string, baseUrl: string): OrderForm | null {
  const re = /<form\b([^>]*)>/gi;
  const lower = page.toLowerCase();
  let best: { score: number; region: string; action: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page)) !== null) {
    const a = attrsOf(m[1] ?? '');
    const end = lower.indexOf('</form>', re.lastIndex);
    const region = page.slice(re.lastIndex, end === -1 ? page.length : end);
    const score = (region.match(/name=["']service_order\[/g) ?? []).length;
    if (score > 0 && (!best || score > best.score)) best = { score, region, action: a['action'] ?? '' };
  }
  if (!best) return null;
  const controls = controlsIn(best.region);
  const body = bodyFromControls(controls);
  const submit = saveSubmit(best.region);
  if (submit) body.append(submit.name, submit.value);
  return {
    page,
    region: best.region,
    actionUrl: absUrl(baseUrl, best.action || '/service_orders'),
    body,
    controls,
  };
}

/**
 * Find a control by the DOM id the RPA proved live, falling back to its POST
 * name. The ids are the reliable half (rpaSink drives them daily); the names
 * are what Rails actually reads, and only the form itself knows them.
 */
function ctlFor(form: OrderForm, id: string, namePattern: RegExp): Ctl | null {
  return (
    form.controls.find((c) => c.attrs['id'] === id && c.attrs['name']) ??
    form.controls.find((c) => namePattern.test(c.attrs['name'] ?? '')) ??
    null
  );
}

function nameFor(form: OrderForm, id: string, namePattern: RegExp, label: string): string {
  const name = ctlFor(form, id, namePattern)?.attrs['name'];
  if (!name) {
    throw new DataError(`${WHAT}: kolom ${label} (#${id}) tidak ada di form Turboly — struktur form berubah, pakai jalur browser`);
  }
  return name;
}

function optionList(opts: ParsedOption[]): string {
  const texts = opts.map((o) => o.text).filter((t) => t.length > 0).slice(0, 12);
  return texts.length ? texts.join(', ') : '(kosong)';
}

const SESSION_COLLECTION = 'turboly_http_session';

function cookiesFrom(res: Response): string {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/**
 * The SAME document httpRegister.ts and apps/web/lib/turbolyLookup.ts cache
 * into: one session per user means every process must share a cookie instead of
 * logging in against each other and kicking whoever is mid-form.
 */
/**
 * The shared HTTP cookie, but ONLY when it belongs to the account we are about to
 * act as.
 *
 * `turboly_http_session` is a single `_id: 'cookie'` row shared by every worker,
 * and the moment a SECOND Turboly account is in play (worker 2) an unguarded read
 * hands one worker the other's session. The step then fails as "kicked", this
 * layer re-logs in to recover — and THAT login is what kills the caller's own
 * browser session, ~20 s after it started. session.ts guards its own adopter for
 * exactly this reason ("ONLY a cookie we know is ours"); this one did not.
 *
 * A row with no username is from before the field existed: unknowable, so unused.
 */
async function cachedCookie(username?: string): Promise<string | null> {
  const doc = (await getDb().collection(SESSION_COLLECTION).findOne({ _id: 'cookie' } as never)) as
    | { cookie?: string; username?: string }
    | null;
  if (!doc?.cookie || !username || doc.username !== username) return null;
  return doc.cookie;
}

/** Stamped with the account, so no other worker can mistake it for its own. */
async function saveCookie(cookie: string, username?: string): Promise<void> {
  await getDb().collection(SESSION_COLLECTION).updateOne(
    { _id: 'cookie' } as never,
    { $set: { cookie, username: username ?? null, at: new Date().toISOString() } },
    { upsert: true },
  );
}

async function login(cfg: HttpServiceOrderConfig): Promise<string> {
  if (!cfg.username || !cfg.password) {
    throw new TransientError(`${WHAT}: sesi Turboly tidak valid dan kredensial robot tidak tersedia — dicoba ulang otomatis`);
  }
  const r1 = await fetch(`${cfg.baseUrl}/users/sign_in`, { redirect: 'manual' });
  const pre = cookiesFrom(r1);
  const html = await r1.text();
  const token =
    /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ??
    /csrf-token"[^>]*content="([^"]+)"/.exec(html)?.[1] ??
    '';
  const res = await fetch(`${cfg.baseUrl}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'user[email]': cfg.username,
      'user[password]': cfg.password,
      authenticity_token: token,
      commit: 'Login',
    }).toString(),
  });
  const cookie = cookiesFrom(res) || pre;
  if (res.status === 302 && cookie) {
    await saveCookie(cookie, cfg.username);
    return cookie;
  }
  if (res.status >= 500) throw new TransientError(`${WHAT}: Turboly tidak bisa diakses saat login (server error) — dicoba ulang otomatis`);
  throw new DataError(`${WHAT}: login Turboly ditolak (HTTP ${res.status}) — periksa kredensial robot`);
}

/** A page served to a kicked/expired session: the sign-in form, or Devise's flash. */
function isSignInHtml(body: string): boolean {
  if (/you have been logged out|sign in or sign up|please login again/i.test(body)) return true;
  if (/name=["']user\[password\]["']/i.test(body)) return true;
  return /action=["'][^"']*\/users\/sign_in/i.test(body);
}

/** Turboly down or behind a proxy error page — retry, never route to review. */
function isOutage(status: number, body: string): boolean {
  if (status >= 500) return true;
  if (!body.trim()) return true;
  if (/site maintenance|undergoing scheduled upgrades/i.test(body)) return true;
  // Proxy error pages are tiny; the length guard stops a real page that merely
  // mentions "gateway" from being read as an outage.
  return body.length < 4000 && /bad gateway|gateway time-?out|service unavailable|temporarily unavailable|cloudflare|nginx/i.test(body);
}

const BLOCK_TAGS = ['div', 'ul', 'p', 'span', 'section', 'td'];

/** Inner HTML of a block, by counting nested same-name tags forward from `from`. */
function blockFrom(html: string, from: number, tag: string): string {
  const open = new RegExp(`<${tag}\\b`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 1;
  let i = from;
  while (depth > 0) {
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(html);
    const c = close.exec(html);
    if (!c) return html.slice(from); // unbalanced markup — take the tail rather than nothing
    if (o && o.index < c.index) {
      depth++;
      i = o.index + 1;
      continue;
    }
    depth--;
    if (depth === 0) return html.slice(from, c.index);
    i = c.index + 1;
  }
  return html.slice(from);
}

/**
 * Turboly's own words for a rejected save — that is what the staff reads in the
 * failure notice, so it must not be replaced with our paraphrase. .alert-error
 * is the Bootstrap 2 class this tenant renders (3+ renamed it).
 */
/** Tenant-wide banners that are never a validation result. */
const STANDING_NOTICE = /email is unverified|verify your email|mohon melakukan pembayaran|payment reminder/i;

function extractFormError(html: string): string | null {
  const scan = (match: (attrs: Attrs) => boolean): string | null => {
    for (const tag of BLOCK_TAGS) {
      const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (!match(attrsOf(m[1] ?? ''))) continue;
        const text = collapse(stripTags(blockFrom(html, re.lastIndex, tag)).replace(/[×✕✖]/g, ' '));
        // Skip the tenant-wide banners Turboly renders on every page — they live
        // in the same .alert-error box and reading one as the failure reason hid
        // a real 422 behind "Email is unverified".
        if (text && !/^success/i.test(text) && !STANDING_NOTICE.test(text)) return text.slice(0, 500);
      }
    }
    return null;
  };
  return (
    scan((a) => /\balert-error\b/.test(a['class'] ?? '')) ??
    scan((a) => (a['id'] ?? '') === 'error_explanation') ??
    scan((a) => /alert|error/i.test(a['class'] ?? ''))
  );
}

const KICKED = Symbol('turboly-session-kicked');
type Kicked = typeof KICKED;

/**
 * GET a page for this session. Turboly bounces the first navigation after a
 * (re)login to the dashboard, so a non-sign-in redirect is retried instead of
 * being reported as a missing form.
 */
async function fetchPage(
  cfg: HttpServiceOrderConfig,
  path: string,
  cookie: string,
  what: string,
): Promise<{ html: string; url: string } | Kicked> {
  const url = absUrl(cfg.baseUrl, path);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', headers: { cookie, accept: 'text/html,application/xhtml+xml' } });
    } catch (e) {
      // Nothing was written by a GET, so a network failure here is always safe to retry.
      throw new TransientError(`${what}: koneksi ke Turboly gagal (${errMsg(e)}) — dicoba ulang otomatis`);
    }
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400) {
      if (/\/users\/sign_in/.test(location)) return KICKED;
      if (attempt === 3) {
        throw new TransientError(
          `${what}: buka form Turboly dialihkan ke ${location || '(tanpa Location)'} 3× — kemungkinan sesi ter-kick, dicoba ulang otomatis`,
        );
      }
      continue;
    }
    const html = await res.text();
    if (isSignInHtml(html)) return KICKED;
    if (isOutage(res.status, html)) {
      throw new TransientError(`${what}: Turboly sedang tidak bisa diakses (HTTP ${res.status}) — dicoba ulang otomatis`);
    }
    return { html, url };
  }
  throw new TransientError(`${what}: halaman Turboly tidak terbuka — dicoba ulang otomatis`);
}

/**
 * A Select2 JSON endpoint, read with this session. Null means the endpoint
 * merely misbehaved (callers keep their fallbacks); a kicked session throws,
 * because sign-in HTML parsed as "no results" is how a customer got registered
 * twice and how a known car read as "not in Turboly".
 */
async function lookupJson<T>(cfg: HttpServiceOrderConfig, cookie: string, path: string, what: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(absUrl(cfg.baseUrl, path), { redirect: 'manual', headers: { cookie, accept: 'application/json' } });
  } catch {
    return null;
  }
  const location = res.headers.get('location') ?? '';
  if (res.status >= 300 && res.status < 400) {
    if (/\/users\/sign_in/.test(location)) throw new TransientError(`${WHAT}: sesi Turboly ter-kick saat ${what} — dicoba ulang otomatis`);
    return null;
  }
  if (res.status >= 500) throw new TransientError(`${WHAT}: Turboly tidak bisa diakses saat ${what} (HTTP ${res.status}) — dicoba ulang otomatis`);
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = await res.text();
  if (res.status === 200 && (!ctype.includes('json') || isSignInHtml(text))) {
    throw new TransientError(`${WHAT}: sesi Turboly ter-kick saat ${what} — dicoba ulang otomatis`);
  }
  if (res.status !== 200) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface VehicleRow { id: number; registration?: unknown; customer_id?: unknown; customer_name?: unknown; customer_phone?: unknown }
interface CustomerRow { id: number; name?: unknown; phone?: unknown; vehicles?: Array<{ registration?: unknown }> }

/**
 * Customer + vehicle ids for this order.
 *
 * THE CAR STAYS WITH ITS ORIGINAL PERSON: if the plate is already in Turboly,
 * the SO attaches to the ORIGINAL registration's owner (lowest vehicle id) even
 * when someone else brings it in; the carrier becomes a notes line, never a
 * second owner. Every create in this system must be preceded by a lookup, and
 * this is that lookup.
 */
async function resolveParties(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  payload: TurbolyServiceOrderPayload,
): Promise<ServiceOrderParties> {
  const plate = (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, '');
  const typedName = payload.customer.create?.nama ?? '';
  const typedPhone = payload.customer.create?.phone ?? '';

  if (cfg.customerId && cfg.vehicleId) {
    return { customerId: cfg.customerId, vehicleId: cfg.vehicleId, ownerName: typedName, ownerPhone: typedPhone, carrierNote: null };
  }

  // Turboly's search is a PREFIX match on the STORED string, so the plate is
  // queried in both spellings we hold — a format mismatch is exactly what
  // created duplicate records before.
  const terms = [...new Set([plate, payload.vehicleRegistration].map((t) => (t ?? '').trim()).filter((t) => t.length >= 3))];
  const byId = new Map<number, VehicleRow>();
  let complete = true;
  for (const t of terms) {
    const j = await lookupJson<{ vehicles?: VehicleRow[] }>(
      cfg,
      cookie,
      `/lookup/vehicles.json?search_term=${encodeURIComponent(t)}&page_limit=30&page=1`,
      'cari kendaraan',
    );
    if (j === null) { complete = false; continue; } // endpoint hiccup — not an answer about this plate
    for (const v of j.vehicles ?? []) {
      if (typeof v?.id !== 'number') continue;
      if (normPlate(String(v.registration ?? '')) !== normPlate(plate)) continue;
      byId.set(v.id, v);
    }
  }
  const original = [...byId.values()].sort((a, b) => a.id - b.id)[0];

  if (original) {
    const ownerName = String(original.customer_name ?? '');
    const ownerPhone = String(original.customer_phone ?? '');
    const customerId =
      cfg.customerId ?? (String(original.customer_id ?? '') || (await ownerCustomerId(cfg, cookie, ownerName, ownerPhone, plate)));
    if (!customerId) {
      throw new DataError(
        `${WHAT}: kendaraan ${plate} ada di Turboly (id ${original.id}) tapi pemiliknya "${ownerName || '-'}" tidak bisa dipastikan — cek manual, jangan buat customer baru`,
      );
    }
    const typedKey = typedPhone ? canonPhoneKey(typedPhone) : '';
    const ownerKey = ownerPhone ? canonPhoneKey(ownerPhone) : '';
    const differs = ownerKey
      ? typedKey !== '' && typedKey !== ownerKey
      : Boolean(typedName) && typedName.trim().toUpperCase() !== ownerName.trim().toUpperCase();
    return {
      customerId,
      vehicleId: cfg.vehicleId ?? String(original.id),
      ownerName,
      ownerPhone,
      carrierNote: differs
        ? `Dibawa oleh: ${typedName || '-'} (${typedPhone ? localPhone(typedPhone) : '-'}) — kendaraan tetap atas nama ${ownerName}`
        : null,
    };
  }

  // The caller just created this vehicle and handed us its id. Turboly's prefix
  // search can lag its own write, and reporting "vehicle missing" again is how
  // the caller ends up registering the same plate twice.
  if (cfg.vehicleId) {
    const known = cfg.customerId ? { id: Number(cfg.customerId) } : await findCustomer(cfg, cookie, payload);
    if (known) {
      return { customerId: String(known.id), vehicleId: cfg.vehicleId, ownerName: typedName, ownerPhone: typedPhone, carrierNote: null };
    }
  }

  // A half-answered sweep must never read as "plate unknown": that verdict ends
  // in a second vehicle, or a second customer.
  if (!complete) {
    throw new TransientError(`${WHAT}: pencarian kendaraan ${plate} tidak terjawab penuh — dicoba ulang otomatis`);
  }

  const existing = await findCustomer(cfg, cookie, payload);
  if (existing) {
    // Typed signal, not a failure: the caller creates the vehicle (/vehicles/new)
    // for THIS customer and re-runs the push.
    throw new NeedAddVehicleError(
      `${WHAT}: customer ${existing.id} (${String(existing.name ?? '')}) sudah ada tapi kendaraan ${plate} belum terdaftar — buat kendaraannya dulu, lalu ulangi`,
    );
  }
  throw new DataError(
    `${WHAT}: customer "${typedName || payload.customer.existingQuery || '-'}" dan kendaraan ${plate} belum ada di Turboly — daftarkan customer + kendaraan dulu, baru buat Service Order`,
  );
}

/** The owner's customer id when the vehicle row didn't carry one: same identity rules, plate as tie-break. */
async function ownerCustomerId(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  ownerName: string,
  ownerPhone: string,
  plate: string,
): Promise<string> {
  const rows = await customerRows(cfg, cookie, [ownerPhone, ownerName].filter((t) => t.trim().length >= 3));
  if (!rows) return '';
  const key = canonPhoneKey(ownerPhone);
  const holdsPlate = (c: CustomerRow) => (c.vehicles ?? []).some((v) => normPlate(String(v?.registration ?? '')) === normPlate(plate));
  const matches = rows.filter((c) => (key.length >= 8 ? canonPhoneKey(String(c.phone ?? '')) === key : normText(String(c.name ?? '')) === normText(ownerName)));
  const ranked = matches.sort((a, b) => a.id - b.id);
  return String((ranked.find(holdsPlate) ?? ranked[0])?.id ?? '');
}

/**
 * The existing customer for this SPK, or null when every stored spelling really
 * answered and nobody holds the number. Never null on a half-answered sweep —
 * that is how the same person gets registered twice.
 */
async function findCustomer(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  payload: TurbolyServiceOrderPayload,
): Promise<CustomerRow | null> {
  const q = (payload.customer.existingQuery ?? '').trim();
  // existingQuery is doc.customer.turbolyCustomerId when we have one, else a
  // phone (E.164, so it starts with '+') or a name — a short all-digit value is
  // therefore an id, and it is only ever used as a positive match.
  if (/^[1-9]\d{0,7}$/.test(q) && canonPhoneKey(q).length < 8) return { id: Number(q) };

  const phone = payload.customer.create?.phone ?? '';
  const key = canonPhoneKey(phone);
  if (key.length >= 8) {
    const rows = await customerRows(cfg, cookie, [localPhone(key), key, `62${key}`, `+62${key}`, phone]);
    if (rows === null) throw new TransientError(`${WHAT}: cek customer tidak terjawab penuh — dicoba ulang otomatis`);
    // Identity is the phone on its canonical key; the ORIGINAL (lowest id) owns the person.
    const mine = rows.filter((c) => canonPhoneKey(String(c.phone ?? '')) === key).sort((a, b) => a.id - b.id);
    return mine[0] ?? null;
  }
  const nama = payload.customer.create?.nama ?? '';
  if (nama.trim().length < 3) return null;
  const rows = await customerRows(cfg, cookie, [nama]);
  if (rows === null) throw new TransientError(`${WHAT}: cek customer tidak terjawab penuh — dicoba ulang otomatis`);
  // No phone → EXACT name only, so a new "FRANK" never merges into "FRANKI".
  return rows.filter((c) => normText(String(c.name ?? '')) === normText(nama)).sort((a, b) => a.id - b.id)[0] ?? null;
}

/** Merged customer rows for every search term. Null when ANY term failed to answer. */
async function customerRows(cfg: HttpServiceOrderConfig, cookie: string, terms: string[]): Promise<CustomerRow[] | null> {
  const wanted = [...new Set(terms.map((t) => (t ?? '').trim()).filter((t) => t.length >= 3))];
  if (!wanted.length) return [];
  const byId = new Map<number, CustomerRow>();
  for (const t of wanted) {
    const j = await lookupJson<{ customers?: CustomerRow[] }>(
      cfg,
      cookie,
      `/lookup/customers.json?search_term=${encodeURIComponent(t)}&page_limit=30&page=1`,
      'cari customer',
    );
    if (j === null) return null;
    for (const c of j.customers ?? []) if (typeof c?.id === 'number') byId.set(c.id, c);
  }
  return [...byId.values()];
}

/**
 * The row the "Add Service Item" link inserts. Same mechanism as the address
 * row in httpRegister: the anchor carries the whole <tr> in
 * data-association-insertion-template with a placeholder standing in for the
 * row index, and the page's own JS just substitutes an index and appends it.
 */
interface RowTemplate { template: string; placeholder: string }

function serviceRowTemplateOf(page: string, region: string): RowTemplate | null {
  const candidates: string[] = [];
  for (const html of [region, page]) {
    const re = /<a\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const t = attrsOf(m[1] ?? '')['data-association-insertion-template'];
      if (t) candidates.push(t);
    }
    if (candidates.length) break;
  }
  // The page carries one insertion anchor per tab (services, spareparts,
  // sublet, inspections); the services one is identified by the product
  // picker's own class — the same marker rpaSink counts rows with — not by
  // position, which changes when Turboly reorders the tabs.
  let template =
    candidates.find((t) => /input-service-product/.test(t)) ??
    candidates.find((t) => /additional-line-item-row/.test(t) && /\[quantity\]/.test(t)) ??
    null;
  if (!template) {
    // Fallback: an inert prototype row rendered into the page (no cocoon anchor).
    const re = /<tr\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(page)) !== null) {
      const cls = attrsOf(m[1] ?? '')['class'] ?? '';
      if (!/additional-line-item-row/.test(cls)) continue;
      const row = blockFrom(page, re.lastIndex, 'tr');
      // Only a TEMPLATE row has a non-numeric index; a real saved row has "0", "1"…
      if (/_attributes\]\[(?!\d+\])([^\]\[]+)\]/.test(row) && /input-service-product|\[quantity\]/.test(row)) {
        template = row;
        break;
      }
    }
  }
  if (!template) return null;
  // Read the placeholder out of the template's own field names rather than
  // assuming cocoon's "new_…": a gem swap would rename it.
  const placeholder = /_attributes\]\[([^\]\[]+)\]/.exec(template)?.[1];
  return placeholder ? { template, placeholder } : null;
}

interface ProductHit { id: string; price: number | null }

/**
 * The service product's numeric id. The row picker is a REMOTE Select2, so the
 * catalog is not in the form HTML and the id must come from the endpoint the
 * widget itself calls — which is read off the page rather than assumed, with
 * the /lookup/*.json shape every other Turboly picker uses as the last resort.
 */
async function productIdFor(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  urls: string[],
  storeId: string,
  line: ServiceLine,
  cache: Map<string, ProductHit>,
  dead: Set<string>,
): Promise<ProductHit> {
  const cacheKey = `${line.expectedSku}|${line.serviceName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (cfg.resolveProductId) {
    const injected = await cfg.resolveProductId(line);
    if (injected) {
      const hit: ProductHit = { id: String(injected), price: null };
      cache.set(cacheKey, hit);
      return hit;
    }
  }

  const terms = [...new Set([line.serviceName, line.expectedSku].map((t) => (t ?? '').trim()).filter(Boolean))];
  for (const term of terms) {
    for (const url of urls) {
      if (dead.has(url)) continue;
      const sep = url.includes('?') ? '&' : '?';
      const j = await lookupJson<unknown>(
        cfg,
        cookie,
        `${url}${sep}search_term=${encodeURIComponent(term)}&page_limit=30&page=1&store_id=${encodeURIComponent(storeId)}`,
        `cari produk "${term}"`,
      );
      if (j === null) { dead.add(url); continue; }
      const rows = jsonRows(j);
      if (!rows.length) continue;
      const bySku = rows.find((r) => normText(String(r['sku'] ?? r['code'] ?? r['product_code'] ?? '')) === normText(line.expectedSku));
      const byName = rows.find((r) => normText(String(r['name'] ?? r['text'] ?? r['label'] ?? r['product_name'] ?? '')) === normText(line.serviceName));
      const row = bySku ?? byName;
      if (!row) continue;
      const id = String(row['id'] ?? row['value'] ?? '');
      if (!id) continue;
      const rawPrice = row['price_inc_tax'] ?? row['price'] ?? row['sale_price'];
      const price = typeof rawPrice === 'number' ? rawPrice : Number.parseFloat(String(rawPrice ?? '')) || null;
      const hit: ProductHit = { id, price };
      cache.set(cacheKey, hit);
      return hit;
    }
  }
  throw new DataError(
    `${WHAT}: jasa "${line.serviceName}" (SKU ${line.expectedSku}) tidak ditemukan di katalog Turboly — periksa mapping SKU atau pakai jalur browser`,
  );
}

/** The first array of id-bearing objects in a Select2 JSON envelope, whatever it is named. */
function jsonRows(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 3 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    const objs = value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
    return objs.some((o) => 'id' in o || 'value' in o) ? objs : [];
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const rows = jsonRows(v, depth + 1);
    if (rows.length) return rows;
  }
  return [];
}

/** Where the product Select2 fetches from: what the page declares first, guesses last. */
function productLookupUrls(page: string, rowTemplate: string): string[] {
  const out: string[] = [];
  const push = (u?: string | null): void => {
    if (!u) return;
    const clean = u.trim();
    if (!/^\/[^\s"'<>]*$/.test(clean)) return;
    if (/\.(js|css|png|jpe?g|svg|gif|woff2?)$/i.test(clean)) return;
    if (!out.includes(clean)) out.push(clean);
  };
  for (const c of controlsIn(rowTemplate)) {
    if (!/input-service-product|product/i.test(`${c.attrs['class'] ?? ''} ${c.attrs['name'] ?? ''}`)) continue;
    for (const [k, v] of Object.entries(c.attrs)) if (/url|source|path|autocomplete/i.test(k)) push(v);
  }
  const re = /["'](\/[a-z0-9_\-/]*(?:product|service_item|line_item)[a-z0-9_\-/.]*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page)) !== null) push(m[1]);
  for (const guess of ['/lookup/products.json', '/lookup/service_products.json', '/lookup/products']) push(guess);
  return out.slice(0, 6);
}

/**
 * The store's users (advisors/salespeople) as Turboly's own form JS loads them:
 * the select ships EMPTY in the HTML and is populated from this endpoint once a
 * store is chosen. Best-effort — an unreachable endpoint just leaves the caller
 * to supply ids, and never silently picks somebody.
 */
async function fetchStoreUsers(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  storeId: string,
): Promise<Array<{ id: string; name: string }>> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/lookup/store_users.json?store_id=${encodeURIComponent(storeId)}&context=ServiceOrder`;
  const res = await fetch(url, { headers: { cookie, accept: 'application/json' } }).catch(() => null);
  if (!res || !res.ok) return [];
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!ctype.includes('json')) return [];
  const j = (await res.json().catch(() => null)) as unknown;
  const rows = Array.isArray(j)
    ? j
    : ((j as { users?: unknown[]; store_users?: unknown[]; results?: unknown[] })?.users ??
       (j as { store_users?: unknown[] })?.store_users ??
       (j as { results?: unknown[] })?.results ??
       []);
  // Turboly answers with select2 PAIRS — [["DEVI FITRIANI", 21797], …] — not
  // objects; an object-shaped parser reads that as an empty list and then
  // refuses to save because "the advisor is not in the list".
  return (rows as unknown[])
    .map((row) => {
      if (Array.isArray(row)) {
        const [a, b] = row as [unknown, unknown];
        return { id: String(b ?? ''), name: String(a ?? '') };
      }
      const r = row as Record<string, unknown>;
      return {
        id: String(r['id'] ?? r['value'] ?? ''),
        name: String(r['name'] ?? r['text'] ?? r['full_name'] ?? ''),
      };
    })
    .filter((r) => r.id && r.name);
}

/** Override a field. set() collapses Rails' hidden-companion pair to one value. */
function setField(body: URLSearchParams, name: string, value: string): void {
  body.set(name, value);
}

/**
 * Every header field the RPA fills, by the ids it proved live. Order-of-truth:
 * the id locates the control, the control tells us the POST name.
 */
async function applyHeader(form: OrderForm, payload: TurbolyServiceOrderPayload, cfg: HttpServiceOrderConfig, parties: ServiceOrderParties, notes: string, cookie: string): Promise<void> {
  const store = ctlFor(form, 'store-id', /\[store_id\]$/);
  if (!store?.attrs['name']) throw new DataError(`${WHAT}: kontrol Store tidak ada di form Turboly`);
  const storeOpts = optionsOf(store.inner);
  if (storeOpts.length && !storeOpts.some((o) => o.value === payload.storeTurbolyId)) {
    throw new DataError(
      `${WHAT}: store id ${payload.storeTurbolyId} (${payload.storeName}) tidak ada di daftar Store Turboly. Pilihan: ${optionList(storeOpts)}`,
    );
  }
  setField(form.body, store.attrs['name'], payload.storeTurbolyId);

  // Type defaults to "General" on the form; a miss leaves Turboly's own default
  // rather than guessing — same tolerance rpaSink has.
  const type = ctlFor(form, 'order-type', /\[(order_type|so_type|service_order_type)/);
  if (type?.attrs['name'] && payload.type) {
    const opt = optionsOf(type.inner).find((o) => normText(o.text) === normText(payload.type));
    if (opt) setField(form.body, type.attrs['name'], opt.value);
  }

  // The store's user list is AJAX, so the fetched HTML has an EMPTY advisor
  // select — the same endpoint Turboly's own JS calls fills it.
  const storeUsers = await fetchStoreUsers(cfg, cookie, payload.storeTurbolyId);
  applyPerson(form, 'service-advisor-id', /\[(service_advisor_id|advisor_id)\]$/, payload.serviceAdvisorName, cfg.serviceAdvisorId, 'Service Advisor', storeUsers);
  applyPerson(form, 'salesperson-id', /\[salesperson_id\]$/, payload.salespersonName, cfg.salespersonId, 'Salesperson', storeUsers);

  // The Select2 pickers post ids, not names — these are the hidden inputs behind
  // #s2id_select2-input-customer / #s2id_select2-input-vehicle.
  setField(form.body, nameFor(form, 'select2-input-customer', /\[customer_id\]$/, 'Customer'), parties.customerId);
  setField(form.body, nameFor(form, 'select2-input-vehicle', /\[vehicle_id\]$/, 'Vehicle'), parties.vehicleId);

  setField(form.body, nameFor(form, 'odometer', /\[odometer\]$/, 'Odometer'), payload.odometer);
  setField(form.body, nameFor(form, 'service_order_reference_no', /\[reference_no\]$/, 'Reference Number'), payload.referenceNumber);
  // Plan date/time are posted exactly as the picker would hold them; Turboly
  // rejects a plan time that is not in the future (payload.ts buffers for that).
  setField(form.body, nameFor(form, 'service-date', /\[(plan_)?service_date\]$/, 'Plan Service Date'), payload.planServiceDate);
  setField(form.body, nameFor(form, 'service-time', /\[(plan_)?service_time\]$/, 'Plan Service Time'), payload.planServiceTime);

  const notesCtl = ctlFor(form, 'service_order_notes', /\[notes\]$/);
  if (notesCtl?.attrs['name'] && notes) setField(form.body, notesCtl.attrs['name'], notes);
}

/**
 * Service Advisor / Salesperson. The store's user list loads by AJAX after the
 * store is picked, so the select can legitimately be empty in fetched HTML —
 * then only an id supplied by the caller (tb_mechanics) can fill it. Never
 * auto-pick a first option: the wrong advisor gets the sales credit.
 */
function applyPerson(form: OrderForm, id: string, namePattern: RegExp, wantedName: string, explicitId: string | undefined, label: string, storeUsers: Array<{ id: string; name: string }>): void {
  const ctl = ctlFor(form, id, namePattern);
  if (!ctl?.attrs['name']) throw new DataError(`${WHAT}: kontrol ${label} tidak ada di form Turboly`);
  if (explicitId) {
    setField(form.body, ctl.attrs['name'], explicitId);
    return;
  }
  const opts = [
    ...optionsOf(ctl.inner).filter((o) => o.value),
    ...storeUsers.map((u) => ({ value: u.id, text: u.name, selected: false, disabled: false })),
  ];
  // EXACT match only, never a first-option fallback: the wrong name here takes
  // another person's sales credit, which is worse than refusing to save.
  const hit = opts.find((o) => normText(o.text) === normText(wantedName));
  if (!hit) {
    throw new DataError(
      `${WHAT}: ${label} "${wantedName || '(kosong)'}" tidak ada di daftar form Turboly (daftar user store dimuat via AJAX). Pilihan yang terbaca: ${optionList(opts)}`,
    );
  }
  setField(form.body, ctl.attrs['name'], hit.value);
}

/** Append one service-line row exactly as the page's own "Add Service Item" JS would. */
function appendServiceRow(form: OrderForm, tpl: RowTemplate, index: string, line: ServiceLine, product: ProductHit, warnings: string[]): void {
  const row = tpl.template.split(tpl.placeholder).join(index);
  const ctls = controlsIn(row);
  const body = bodyFromControls(ctls);
  const keys = (): string[] => [...body.keys()];

  const productKey =
    ctls.find((c) => /(^|\s)input-service-product(\s|$)/.test(c.attrs['class'] ?? '') && c.attrs['name'])?.attrs['name'] ??
    keys().find((k) => /\[(service_product_id|product_id|item_id)\]$/.test(k)) ??
    keys().find((k) => /product/i.test(k) && /_id\]$/.test(k));
  if (!productKey) {
    throw new DataError(`${WHAT}: baris jasa Turboly tidak punya kolom produk yang dikenali — struktur form berubah, pakai jalur browser`);
  }
  body.set(productKey, product.id);

  const qtyKey = keys().find((k) => /\[quantity\]$/.test(k)) ?? keys().find((k) => /\[qty\]$/.test(k));
  if (qtyKey) body.set(qtyKey, String(line.qty || 1));

  const descKey = keys().find((k) => /\[description\]$/.test(k)) ?? keys().find((k) => /\[notes\]$/.test(k));
  if (descKey) body.set(descKey, line.description || line.serviceName);

  // The browser gets the catalog price from Turboly's JS after picking the
  // product; over HTTP nothing fills it, so a quoted price wins and the
  // catalog price read from the lookup stands in — never a silent 0.
  const priceKey = keys().find((k) => /price/i.test(k) && !/discount/i.test(k));
  const price = line.priceIncTax != null && line.priceIncTax > 0 ? line.priceIncTax : product.price;
  if (priceKey && price != null && price > 0) {
    body.set(priceKey, String(price));
  } else if (priceKey) {
    warnings.push(`Harga "${line.serviceName}" tidak diisi robot — Turboly memakai harga katalognya sendiri; periksa nominalnya`);
  }

  const destroyKey = keys().find((k) => /\[_destroy\]$/.test(k));
  if (destroyKey) body.set(destroyKey, '0');

  for (const [k, v] of body.entries()) form.body.append(k, v);
}

/**
 * POST the filled form. redirect:'manual' is load-bearing: the 302 Location is
 * the only place the new Service Order id appears, and following it would
 * replace that evidence with the rendered page.
 */
async function postOrder(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  form: OrderForm,
  referer: string,
): Promise<{ id: string; url: string }> {
  let res: Response;
  try {
    res = await fetch(form.actionUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
        referer,
        origin: cfg.baseUrl.replace(/\/+$/, ''),
      },
      body: form.body.toString(),
    });
  } catch (e) {
    // Saved-or-not is genuinely unknown once the request left: an automatic
    // retry here is how a second Service Order gets created. Route to review.
    throw new DataError(
      `${WHAT}: simpan tidak terkonfirmasi — koneksi terputus saat menyimpan (${errMsg(e)}). Cek di Turboly apakah SO sudah terbuat SEBELUM mencoba lagi`,
    );
  }
  const location = res.headers.get('location') ?? '';
  const body = await res.text();

  if (res.status >= 300 && res.status < 400) {
    if (/\/users\/sign_in/.test(location)) throw kickedOnSave();
    const id = /\/service_orders\/(\d+)/.exec(location)?.[1];
    if (id) return { id, url: absUrl(cfg.baseUrl, location) };
    throw new DataError(
      `${WHAT}: simpan tidak terkonfirmasi — Turboly mengalihkan ke ${location || '(tanpa Location)'} tanpa nomor Service Order. Cek manual sebelum ulang`,
    );
  }
  if (isSignInHtml(body)) throw kickedOnSave();
  if (isOutage(res.status, body)) {
    throw new TransientError(`${WHAT}: Turboly sedang tidak bisa diakses (HTTP ${res.status}) saat menyimpan — data belum tersimpan, dicoba ulang otomatis`);
  }
  // A remote (data-remote) form answers 200 with JS that redirects; the id is
  // still the only proof of a save.
  const jsId = /\/service_orders\/(\d+)/.exec(body.slice(0, 4000));
  if (jsId?.[1] && /window\.location|location\.(href|replace)|Turbolinks/i.test(body.slice(0, 4000))) {
    return { id: jsId[1], url: absUrl(cfg.baseUrl, `/service_orders/${jsId[1]}`) };
  }
  const inline = extractFormError(body);
  let msg = inline ?? `(HTTP ${res.status}, tanpa pesan error yang terbaca)`;
  if (/account code can't be blank/i.test(msg)) {
    // Same trap the RPA hit: the store config demands an Account Code but the
    // list is empty, so no amount of retrying helps.
    msg += ' — konfigurasi store di Turboly mewajibkan Account Code tapi daftarnya KOSONG; definisikan Account Code (Setup → Accounting) atau matikan kewajibannya untuk store ini';
  }
  throw new DataError(`${WHAT} ditolak Turboly: ${msg}`);
}

/**
 * A kick detected on the POST is NOT replayed here, unlike httpRegister: Devise
 * bounces an unauthenticated request before the controller runs, but the cost
 * of being wrong is a duplicate Service Order, so the caller must confirm by
 * reference number before it retries.
 */
function kickedOnSave(): TransientError {
  return new TransientError(
    `${WHAT}: sesi Turboly ter-kick saat menyimpan — cek dulu apakah SO dengan reference number ini sudah ada sebelum push ulang`,
  );
}

/** Turboly's generated document number. Best-effort: the order already exists, so a miss never fails. */
async function readDocNumber(cfg: HttpServiceOrderConfig, cookie: string, url: string): Promise<string | null> {
  const page = await fetchPage(cfg, url, cookie, `${WHAT}: baca nomor dokumen`).catch(() => null);
  if (!page || page === KICKED) return null;
  const pattern = /\b[A-Z]{2,4}\/[A-Z0-9]{2,6}\/\d{4,}\b/;
  for (const c of controlsIn(page.html)) {
    if (!/document/i.test(`${c.attrs['id'] ?? ''} ${c.attrs['name'] ?? ''}`)) continue;
    const v = (c.attrs['value'] ?? '').trim();
    if (pattern.test(v)) return v;
  }
  return pattern.exec(collapse(stripTags(page.html)))?.[0] ?? null;
}

async function establishCookie(cfg: HttpServiceOrderConfig): Promise<string> {
  if (cfg.cookie) return cfg.cookie;
  return (await cachedCookie(cfg.username)) ?? (await login(cfg));
}

/**
 * Resolve customer + vehicle without writing anything — for callers that want
 * to decide (register the customer? add the vehicle?) before pushing. Raises
 * NeedAddVehicleError when the customer exists but the car does not.
 */
export async function resolveServiceOrderPartiesHttp(
  payload: TurbolyServiceOrderPayload,
  cfg: HttpServiceOrderConfig,
): Promise<ServiceOrderParties> {
  return resolveParties(cfg, await establishCookie(cfg), payload);
}

/**
 * Create the Service Order. Returns the created order, or throws:
 *   DataError            — Turboly rejected it, or the outcome is ambiguous (never auto-retry)
 *   TransientError       — kicked session / vendor outage (safe to retry from scratch)
 *   NeedAddVehicleError  — customer exists, vehicle does not; create it and re-run
 *
 * Approve is deliberately not attempted here.
 */
export async function createServiceOrderHttp(
  payload: TurbolyServiceOrderPayload,
  cfg: HttpServiceOrderConfig,
): Promise<HttpServiceOrderResult> {
  if (payload.sparepartLines.length) {
    // Silently dropping a line is worse than failing: fail LOUD, same as the RPA.
    throw new DataError(
      `${WHAT}: ${payload.sparepartLines.length} baris sparepart belum didukung jalur HTTP (${payload.sparepartLines.map((s) => s.expectedSku).join(', ')}) — pakai jalur browser`,
    );
  }
  if (!payload.serviceLines.length) {
    throw new DataError(`${WHAT}: tidak ada baris jasa untuk dikirim`);
  }

  let cookie = await establishCookie(cfg);
  const canRelogin = Boolean(cfg.username && cfg.password);
  const warnings: string[] = [];

  // Everything up to (not including) the POST writes nothing, so this phase can
  // be replayed safely — and it must be replayed as a whole, because the
  // authenticity token is bound to the cookie that fetched the form.
  let prepared: { form: OrderForm; referer: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    warnings.length = 0;
    try {
      const parties = await resolveParties(cfg, cookie, payload);
      prepared = await prepareForm(cfg, cookie, payload, parties, warnings);
      break;
    } catch (e) {
      if (attempt === 2 || !canRelogin || !(e instanceof TransientError)) throw e;
      cookie = await login(cfg);
    }
  }
  if (!prepared) throw new TransientError(`${WHAT}: form Turboly tidak bisa disiapkan — dicoba ulang otomatis`);

  const created = await postOrder(cfg, cookie, prepared.form, prepared.referer);
  return {
    serviceOrderNo: await readDocNumber(cfg, cookie, created.url),
    serviceOrderUrl: created.url,
    serviceOrderId: created.id,
    warnings,
  };
}

/** GET the form and fill it. Throws TransientError when the session is (or turns) dead. */
async function prepareForm(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  payload: TurbolyServiceOrderPayload,
  parties: ServiceOrderParties,
  warnings: string[],
): Promise<{ form: OrderForm; referer: string }> {
  // The advisor/salesperson lists are rendered per store, so when the plain form
  // comes back without them the store-scoped URL is tried once before giving up.
  const paths = [
    '/service_orders/new',
    `/service_orders/new?store_id=${encodeURIComponent(payload.storeTurbolyId)}`,
  ];
  let lastError: DataError | null = null;
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i] ?? paths[0]!;
    const page = await fetchPage(cfg, path, cookie, WHAT);
    if (page === KICKED) throw new TransientError(`${WHAT}: sesi Turboly ter-kick saat membuka form — dicoba ulang otomatis`);
    const form = serviceOrderFormOf(page.html, cfg.baseUrl);
    if (!form) {
      const title = collapse(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html)?.[1] ?? '')) || '(tanpa judul)';
      throw new DataError(`${WHAT}: form Service Order tidak ada di ${page.url} — halaman yang terbuka: "${title}"`);
    }
    // Rails rejects the POST without a token, and the token is bound to the
    // cookie used for THIS GET — never reuse one across sessions.
    if (!form.body.get('authenticity_token')) {
      const meta = /csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(page.html)?.[1];
      if (!meta) throw new DataError(`${WHAT}: authenticity_token tidak ada di form Turboly — POST pasti ditolak`);
      form.body.set('authenticity_token', meta);
    }

    const notes = [payload.notes, parties.carrierNote].filter(Boolean).join('\n');
    try {
      await applyHeader(form, payload, cfg, parties, notes, cookie);
    } catch (e) {
      // Only the per-store user lists justify a second GET; anything else is a
      // real structural problem and re-fetching would just hide it.
      if (e instanceof DataError && /Service Advisor|Salesperson/.test(e.message) && i === 0) {
        lastError = e;
        continue;
      }
      throw e;
    }
    // Pushed only once the header stuck: the store-scoped retry above re-enters
    // this loop and would otherwise report the carrier twice.
    if (parties.carrierNote) warnings.push(parties.carrierNote);

    await applyServiceLines(cfg, cookie, form, payload, warnings);
    return { form, referer: page.url };
  }
  throw lastError ?? new DataError(`${WHAT}: form Turboly tidak bisa diisi`);
}

async function applyServiceLines(
  cfg: HttpServiceOrderConfig,
  cookie: string,
  form: OrderForm,
  payload: TurbolyServiceOrderPayload,
  warnings: string[],
): Promise<void> {
  const tpl = serviceRowTemplateOf(form.page, form.region);
  if (!tpl) {
    throw new DataError(`${WHAT}: template baris "Add Service Item" tidak ada di form Turboly — baris jasa tidak bisa diisi, pakai jalur browser`);
  }
  const urls = productLookupUrls(form.page, tpl.template);
  const cache = new Map<string, ProductHit>();
  const dead = new Set<string>();
  const base = Date.now();
  for (let i = 0; i < payload.serviceLines.length; i++) {
    const line = payload.serviceLines[i];
    if (!line) continue;
    const product = await productIdFor(cfg, cookie, urls, payload.storeTurbolyId, line, cache, dead);
    // Same shape of index the page's own JS generates, unique per row.
    appendServiceRow(form, tpl, String(base + i), line, product, warnings);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
