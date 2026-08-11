import { getDb } from '../mongo.js';
import { jaroWinkler, parsePlate } from '../indonesia.js';
import { DataError, TransientError, NeedCreateMakeError } from './rpaSink.js';

/**
 * Vehicle creation over plain HTTP — GET /vehicles/new → POST /vehicles, the
 * same echo-the-form technique httpRegister.ts uses for customers.
 *
 * Why it exists: rpaSink.addVehicleToExistingCustomer costs a browser page load
 * plus four select2 remote searches (~25s of the ~2 minutes an owner waits), and
 * every one of those seconds is a second the robot holds Turboly's SINGLE
 * per-user session on a half-filled form. Two round trips instead.
 *
 * The scanning helpers below are deliberate near-duplicates of the ones in
 * httpRegister.ts: that file is owned by another workstream right now and
 * exports none of them. Extracting a shared `httpForm.ts` is the obvious
 * follow-up once both files stop moving.
 *
 * No jsdom in this package, so every "parse" is a regular expression plus a
 * forward scan. Safe only because Rails escapes &, <, >, " and ' inside
 * attribute values, so no tag body ever contains a raw '>'.
 */

export interface HttpVehicleConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface HttpVehicleArgs {
  /** Turboly customer id that will OWN the vehicle (not a name — see lookup rules). */
  customerId: string;
  /** Plate as captured; stored space-stripped, the spelling rpaSink writes. */
  registration: string;
  make: string;
  model: string;
  year?: string;
  color?: string;
  odometer?: string;
  /** Native option text of the vehicle type; Turboly's is "Car". */
  vehicleTypeLabel?: string;
  /** Operator ticked "buat merk baru" on the SPK form — see NeedCreateMakeError. */
  createMakeConfirmed?: boolean;
  /**
   * Create a second row for a plate already registered to SOMEBODY ELSE.
   * Off by default: the car stays with its original owner, and Turboly happily
   * accepts one vehicle row per customer for the same plate — i.e. this flag is
   * the difference between attaching and silently forking the car's history.
   */
  allowSecondOwnerRow?: boolean;
}

export interface TurbolyVehicleMatch {
  id: number;
  registration: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
}

export interface HttpVehicleResult {
  vehicleId: string | null;
  vehicleUrl: string | null;
  /** false when an existing row already covered this plate for this customer. */
  created: boolean;
  /** The row we attached to instead of creating, when created === false. */
  existing: TurbolyVehicleMatch | null;
  /** Set when the plate is registered to a DIFFERENT customer and we did not create. */
  ownedByOther: TurbolyVehicleMatch | null;
  /** Operator-facing notes (model substitutions), same wording rpaSink appends. */
  notes: string[];
}

// ── HTML scanning ────────────────────────────────────────────────────────────

type Attrs = Record<string, string>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', hellip: '…',
};

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

/** Comparison key for option text: case- and whitespace-insensitive. */
function normText(s: string): string {
  return collapse(stripTags(s)).toLowerCase();
}

/** Plate identity key. Turboly stores both "B1234SZA" and "B 1234 SZA" shapes. */
function plateKey(s: string): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface ParsedOption { value: string; text: string; selected: boolean; disabled: boolean; attrs: Attrs }
interface ParsedSelect { name: string; id: string; multiple: boolean; options: ParsedOption[] }
interface ParsedControl { kind: 'input' | 'select' | 'textarea'; attrs: Attrs; inner: string }

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
      attrs: a,
    });
  }
  return out;
}

/** Walk input/select/textarea in DOCUMENT ORDER — order carries meaning (see bodyFrom). */
function controlsIn(fragment: string): ParsedControl[] {
  const out: ParsedControl[] = [];
  const re = /<(input|select|textarea)\b([^>]*)>/gi;
  const lower = fragment.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const kind = (m[1] ?? '').toLowerCase() as ParsedControl['kind'];
    const attrs = attrsOf(m[2] ?? '');
    if (kind === 'input') {
      out.push({ kind, attrs, inner: '' });
      continue;
    }
    const close = lower.indexOf(`</${kind}>`, re.lastIndex);
    out.push({ kind, attrs, inner: close === -1 ? '' : fragment.slice(re.lastIndex, close) });
    // Options and textarea text hold no further controls; skipping past them keeps
    // a stray "<input" inside placeholder text from being submitted.
    if (close !== -1) re.lastIndex = close + kind.length + 3;
  }
  return out;
}

/**
 * Seed the POST body with what a browser would send for this exact form, then
 * override only the fields we own. Echoing beats a hardcoded field map: Turboly
 * can add, rename or reorder hidden fields and this still posts them.
 *
 * Order matters and append() preserves it: Rails emits a hidden `name=0` input
 * immediately before every checkbox and reads the LAST value for that name.
 */
function bodyFrom(controls: ParsedControl[]): URLSearchParams {
  const body = new URLSearchParams();
  for (const { kind, attrs: a, inner } of controls) {
    const name = a['name'];
    if (!name) continue;
    if ('disabled' in a) continue; // browsers never submit a disabled control
    if (kind === 'textarea') {
      body.append(name, decodeEntities(inner).replace(/^\r?\n/, ''));
      continue;
    }
    if (kind === 'select') {
      const opts = optionsOf(inner);
      if ('multiple' in a) {
        for (const o of opts) if (o.selected && !o.disabled) body.append(name, o.value);
        continue;
      }
      // No option marked selected → the browser selects the first enabled one.
      const chosen = opts.filter((o) => o.selected && !o.disabled).pop() ?? opts.find((o) => !o.disabled);
      if (chosen) body.append(name, chosen.value);
      continue;
    }
    const type = (a['type'] ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') continue;
    if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) continue;
    body.append(name, a['value'] ?? (type === 'checkbox' || type === 'radio' ? 'on' : ''));
  }
  return body;
}

/**
 * The single Save button, mirrored the way a click would send it. Skipped when
 * the form offers several: picking the wrong one changes what the controller
 * does after saving.
 */
function primarySubmit(controls: ParsedControl[]): { name: string; value: string } | null {
  const found = controls
    .filter((c) => c.kind === 'input' && (c.attrs['type'] ?? '').toLowerCase() === 'submit' && c.attrs['name'])
    .map((c) => ({ name: c.attrs['name'] ?? '', value: c.attrs['value'] ?? '' }));
  return found.length === 1 ? (found[0] ?? null) : null;
}

interface VehicleForm {
  actionUrl: string;
  body: URLSearchParams;
  controls: ParsedControl[];
  selects: ParsedSelect[];
}

function absUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Pick the vehicle <form>. Scored by how many vehicle[...] controls each form
 * region holds rather than by action/id: the page also carries the top search
 * form, the sign-out form, and whatever modals ship with the layout.
 */
function vehicleFormOf(page: string, baseUrl: string): VehicleForm | null {
  const re = /<form\b([^>]*)>/gi;
  const lower = page.toLowerCase();
  let best: { score: number; region: string; action: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page)) !== null) {
    const a = attrsOf(m[1] ?? '');
    const end = lower.indexOf('</form>', re.lastIndex);
    const region = page.slice(re.lastIndex, end === -1 ? page.length : end);
    const score = (region.match(/name=["']vehicle\[/g) ?? []).length;
    if (score > 0 && (!best || score > best.score)) best = { score, region, action: a['action'] ?? '' };
  }
  if (!best) return null;
  const controls = controlsIn(best.region);
  const body = bodyFrom(controls);
  const submit = primarySubmit(controls);
  if (submit) body.append(submit.name, submit.value);
  return {
    actionUrl: absUrl(baseUrl, best.action || '/vehicles'),
    body,
    controls,
    selects: controls
      .filter((c) => c.kind === 'select')
      .map((c) => ({
        name: c.attrs['name'] ?? '',
        id: c.attrs['id'] ?? '',
        multiple: 'multiple' in c.attrs,
        options: optionsOf(c.inner),
      })),
  };
}

/**
 * POST name of a control, found by the id Turboly renders → the Rails name we
 * expect → a loose pattern. Ids are checked FIRST because rpaSink's selectors
 * (#vehicle_registration, #vehicle-make-select) are the only part of this form
 * that has been proven live; the names are inferred from Rails convention.
 */
function nameFor(form: VehicleForm, id: string, railsName: string, pattern: RegExp): string | null {
  const byId = form.controls.find((c) => (c.attrs['id'] ?? '') === id)?.attrs['name'];
  if (byId) return byId;
  if (form.controls.some((c) => (c.attrs['name'] ?? '') === railsName)) return railsName;
  const loose = form.controls.find((c) => pattern.test(c.attrs['name'] ?? '') || pattern.test(c.attrs['id'] ?? ''));
  return loose?.attrs['name'] ?? null;
}

function selectFor(form: VehicleForm, id: string, railsName: string, pattern: RegExp): ParsedSelect | null {
  return (
    form.selects.find((s) => s.id === id) ??
    form.selects.find((s) => s.name === railsName) ??
    form.selects.find((s) => pattern.test(s.name) || pattern.test(s.id)) ??
    null
  );
}

/** Set a field when the form actually has it; report the miss to the caller. */
function setIfPresent(form: VehicleForm, id: string, railsName: string, pattern: RegExp, value: string): boolean {
  const name = nameFor(form, id, railsName, pattern);
  if (!name) return false;
  form.body.set(name, value);
  return true;
}

function optionList(select: ParsedSelect | null): string {
  const texts = (select?.options ?? []).map((o) => o.text).filter((t) => t.length > 0).slice(0, 12);
  return texts.length ? texts.join(', ') : '(kosong)';
}

// ── session ──────────────────────────────────────────────────────────────────

const SESSION_COLLECTION = 'turboly_http_session';

function cookiesFrom(res: Response): string {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/**
 * The SAME document httpRegister.ts and apps/web/lib/turbolyLookup.ts cache
 * into: one session per user means every process must share one cookie instead
 * of logging in against each other and kicking whoever is mid-form.
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

async function login(cfg: HttpVehicleConfig): Promise<string> {
  if (!cfg.username || !cfg.password) throw new DataError('Kredensial Turboly belum diisi (username/password kosong)');
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
  if (res.status >= 500) {
    throw new TransientError('Turboly tidak bisa diakses saat login (server error) — dicoba ulang otomatis');
  }
  throw new DataError(`Login Turboly ditolak (HTTP ${res.status}) — periksa kredensial robot`);
}

// ── outcome classification ───────────────────────────────────────────────────

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
 * Turboly's own words for a rejected save — that is what the staff will read in
 * the failure notice, so it must not be replaced with our paraphrase.
 * .alert-error is the Bootstrap 2 class this tenant renders (3+ renamed it).
 */
function extractFormError(html: string): string | null {
  const scan = (match: (attrs: Attrs) => boolean): string | null => {
    for (const tag of BLOCK_TAGS) {
      const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (!match(attrsOf(m[1] ?? ''))) continue;
        const text = collapse(stripTags(blockFrom(html, re.lastIndex, tag)).replace(/[×✕✖]/g, ' '));
        if (text && !/^success/i.test(text)) return text.slice(0, 500);
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

function kickedError(what: string): TransientError {
  return new TransientError(`${what}: sesi Turboly ter-kick oleh login lain — dicoba ulang otomatis`);
}

/**
 * Run one whole read-modify-write cycle with at most ONE re-login. Every caller
 * restarts from its own plate lookup, so replaying a cycle cannot fork a second
 * vehicle row even when the kick landed after Turboly had already written.
 */
async function withCookie<T>(cfg: HttpVehicleConfig, what: string, step: (cookie: string) => Promise<T | Kicked>): Promise<T> {
  let cookie = (await cachedCookie(cfg.username)) ?? (await login(cfg));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await step(cookie);
    if (out !== KICKED) return out;
    if (attempt === 2) break;
    cookie = await login(cfg);
  }
  throw kickedError(what);
}

// ── JSON lookups ─────────────────────────────────────────────────────────────

type LookupOutcome<T> =
  | { kind: 'json'; data: T }
  | { kind: 'kicked' }
  | { kind: 'transient'; why: string }
  | { kind: 'absent'; status: number };

/**
 * Read one /lookup/* endpoint. The whole point of the four-way outcome is that
 * NOTHING except a parsed JSON body is allowed to mean "not in Turboly": a
 * kicked session answers these endpoints with sign-in HTML, and reading that as
 * "plate not found" is precisely how a car gets registered twice.
 */
async function readLookup<T>(cfg: HttpVehicleConfig, cookie: string, path: string): Promise<LookupOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(absUrl(cfg.baseUrl, path), {
      redirect: 'manual',
      headers: { cookie, accept: 'application/json' },
    });
  } catch (e) {
    return { kind: 'transient', why: e instanceof Error ? e.message : String(e) };
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '';
    return /\/users\/sign_in/.test(location) ? { kind: 'kicked' } : { kind: 'transient', why: `redirect ke ${location || '(tanpa Location)'}` };
  }
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  const body = await res.text();
  if (isSignInHtml(body)) return { kind: 'kicked' };
  // Same rule as rpaSink.lookupIsSignIn: a 200 that isn't JSON is the layout,
  // which is what Turboly serves a logged-out XHR.
  if (res.status === 200 && !ctype.includes('json')) return { kind: 'kicked' };
  if (res.status === 404) return { kind: 'absent', status: 404 };
  if (isOutage(res.status, body) || !res.ok) return { kind: 'transient', why: `HTTP ${res.status}` };
  try {
    return { kind: 'json', data: JSON.parse(body) as T };
  } catch {
    return { kind: 'transient', why: 'jawaban lookup bukan JSON yang valid' };
  }
}

/** Strict reader: only a parsed JSON body is an answer; 404 is a broken assumption, not "none". */
async function lookupJson<T>(cfg: HttpVehicleConfig, cookie: string, path: string, what: string): Promise<T | Kicked> {
  const r = await readLookup<T>(cfg, cookie, path);
  if (r.kind === 'json') return r.data;
  if (r.kind === 'kicked') return KICKED;
  const why = r.kind === 'absent' ? `endpoint ${path.split('?')[0]} tidak ada (HTTP 404)` : r.why;
  throw new TransientError(`${what}: lookup Turboly tidak menjawab (${why}) — dicoba ulang otomatis`);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function pickList(data: unknown, keys: string[]): unknown[] | null {
  const direct = asArray(data);
  if (direct) return direct;
  if (!data || typeof data !== 'object') return null;
  for (const k of keys) {
    const list = asArray((data as Record<string, unknown>)[k]);
    if (list) return list;
  }
  return null;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

// ── plate lookup ─────────────────────────────────────────────────────────────

/**
 * Search terms for a plate. Turboly's search is a PREFIX match on the STORED
 * string, so "B1234SZA" never finds a record saved as "B 1234 SZA" — the same
 * format trap that split a customer in two over "+62…" vs "0…". Cheap insurance:
 * query both spellings and merge, since matching is by normalised key anyway.
 */
function plateSearchTerms(plate: string): string[] {
  const compact = plateKey(plate);
  const terms = new Set<string>();
  if (compact) terms.add(compact);
  const raw = (plate ?? '').trim();
  if (raw) terms.add(raw);
  const parsed = parsePlate(raw || compact);
  if (parsed.ok && parsed.display) terms.add(parsed.display);
  // The SPACED spelling, built from the blocks rather than taken from
  // `display` — which is compact now, so reading it here would silently drop
  // the very variant this function exists to cover.
  if (parsed.ok && parsed.area && parsed.number) {
    terms.add([parsed.area, parsed.number, parsed.suffix].filter(Boolean).join(' '));
  }
  return [...terms].filter((t) => t.length >= 3);
}

function matchesFrom(data: unknown, wantKey: string): TurbolyVehicleMatch[] | null {
  const list = pickList(data, ['vehicles', 'results']);
  // A shape change must not read as "plate not found" — no recognisable list is
  // not an answer about this plate.
  if (!list) return null;
  const out: TurbolyVehicleMatch[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const v = row as Record<string, unknown>;
    const registration = str(v['registration']);
    if (plateKey(registration) !== wantKey) continue; // the search also matches owners/notes
    const id = Number(v['id']);
    if (!Number.isFinite(id)) continue;
    const customerId = v['customer_id'] == null ? null : str(v['customer_id']);
    out.push({
      id,
      registration,
      customerId,
      customerName: str(v['customer_name']),
      customerPhone: str(v['customer_phone']),
    });
  }
  return out;
}

async function lookupPlate(cfg: HttpVehicleConfig, cookie: string, plate: string, what: string): Promise<TurbolyVehicleMatch[] | Kicked> {
  const wantKey = plateKey(plate);
  if (wantKey.length < 3) throw new DataError(`${what}: nomor polisi "${plate}" terlalu pendek untuk dicari di Turboly`);
  const byId = new Map<number, TurbolyVehicleMatch>();
  for (const term of plateSearchTerms(plate)) {
    const data = await lookupJson<unknown>(
      cfg,
      cookie,
      `/lookup/vehicles.json?search_term=${encodeURIComponent(term)}&page_limit=30&page=1`,
      what,
    );
    if (data === KICKED) return KICKED;
    const rows = matchesFrom(data, wantKey);
    if (!rows) {
      throw new TransientError(
        `${what}: jawaban /lookup/vehicles.json tidak dikenali (tidak ada daftar "vehicles") — dianggap belum terjawab, dicoba ulang otomatis`,
      );
    }
    for (const r of rows) byId.set(r.id, r);
  }
  // THE ORIGINAL REGISTRATION OWNS THE CAR: lowest id first, everywhere.
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Every Turboly row for this exact plate, oldest registration FIRST.
 *
 * Duplicate plates exist (one row per customer), and the lowest id is the
 * original registration — the car stays with that owner even when a sister or a
 * driver brings it in. Never returns [] for a session problem: a kicked session
 * or an unrecognised answer raises TransientError, because "no rows" is the one
 * verdict that goes on to create a record.
 */
export async function lookupVehiclesByPlateHttp(cfg: HttpVehicleConfig, plate: string): Promise<TurbolyVehicleMatch[]> {
  const what = 'Cari kendaraan';
  return withCookie(cfg, what, (cookie) => lookupPlate(cfg, cookie, plate, what));
}

/** Does this plate already exist, and who owns it? The original registration wins. */
export async function vehicleOriginalOwnerHttp(cfg: HttpVehicleConfig, plate: string): Promise<TurbolyVehicleMatch | null> {
  const rows = await lookupVehiclesByPlateHttp(cfg, plate);
  return rows[0] ?? null;
}

// ── make / model resolution ──────────────────────────────────────────────────

interface Picked { id: string; label: string; note?: string }

/**
 * sync-catalogs.mjs refuses to overwrite the make catalog when the live select
 * yields ≤10 makes ("make list looked broken"): the tenant has ~70. The same
 * gate here decides whether an unmatched make is EVIDENCE the make is missing or
 * merely a list that did not render for a browserless GET.
 */
const MAKE_LIST_IS_REAL = 10;

function usableOptions(select: ParsedSelect | null): ParsedOption[] {
  return (select?.options ?? []).filter((o) => !o.disabled && o.value.trim() !== '' && o.text.trim() !== '');
}

function exactOption(options: ParsedOption[], wanted: string): ParsedOption | null {
  const want = normText(wanted);
  if (!want) return null;
  return options.find((o) => normText(o.text) === want) ?? null;
}

/**
 * Resolve the make to its Turboly id.
 *
 * A MISSING MAKE IS A DIFFERENT PROBLEM: creating a vehicle under the wrong
 * brand is silent corruption, and creating the brand itself is irreversible, so
 * "missing" is only ever concluded from a list we can prove we actually read —
 * a full <select> or a JSON lookup that answered. Anything else is a DataError
 * that routes to review, never NeedCreateMakeError (which makes the caller
 * create the brand).
 */
async function resolveMake(
  cfg: HttpVehicleConfig,
  cookie: string,
  form: VehicleForm,
  args: HttpVehicleArgs,
  vehicleTypeId: string,
  what: string,
): Promise<Picked | Kicked> {
  const wanted = (args.make ?? '').trim();
  const select = selectFor(form, 'vehicle-make-select', 'vehicle[vehicle_make_id]', /vehicle_make|(^|\W)make/i);
  if (!select?.name) throw new DataError(`${what}: kontrol Merk (vehicle make) tidak ada di form Turboly`);
  if (!wanted) throw new DataError(`${what}: merk kendaraan kosong — Turboly tidak bisa membuat kendaraan tanpa merk`);

  const options = usableOptions(select);
  const hit = exactOption(options, wanted);
  if (hit) {
    // HONDA and SUZUKI exist twice in this tenant (car make and motorcycle make).
    // The browser clicks the first select2 result, so first-wins keeps the two
    // paths agreeing; a data-vehicle-type attribute, if Turboly renders one,
    // breaks the tie properly.
    const sameText = options.filter((o) => normText(o.text) === normText(wanted));
    const typed = vehicleTypeId
      ? sameText.find((o) => [o.attrs['data-vehicle-type-id'], o.attrs['data-vehicle-type']].filter(Boolean).includes(vehicleTypeId))
      : undefined;
    const chosen = typed ?? hit;
    return { id: chosen.value, label: chosen.text };
  }

  if (options.length >= MAKE_LIST_IS_REAL) {
    return missingMake(args, wanted, `Pilihan: ${optionList(select)}`, what);
  }

  // The select rendered empty/short — it is select2-remote, or the list is keyed
  // to a vehicle type only the page's JS applies. Ask the endpoint the widget
  // itself reads before concluding anything.
  const fromLookup = await lookupMakeByName(cfg, cookie, wanted, vehicleTypeId);
  if (fromLookup === KICKED) return KICKED;
  if (fromLookup === 'unavailable') {
    throw new DataError(
      `${what}: daftar merk Turboly tidak terbaca lewat HTTP (select kosong, lookup tidak menjawab) — pakai jalur browser untuk kendaraan ini`,
    );
  }
  if (fromLookup === null) return missingMake(args, wanted, 'daftar merk dari lookup Turboly tidak memuat merk ini', what);
  return fromLookup;
}

function missingMake(args: HttpVehicleArgs, wanted: string, detail: string, what: string): never {
  if (args.createMakeConfirmed) {
    throw new NeedCreateMakeError(`make "${wanted}" missing — operator confirmed create`);
  }
  throw new DataError(`${what}: merk "${wanted}" tidak ada di daftar merk Turboly. ${detail}`);
}

/**
 * The makes endpoint is inferred by symmetry with /lookup/vehicle_models (the
 * one sync-catalogs.mjs proved). Candidates are probed in order and a 404 just
 * moves to the next; 'unavailable' means none of them answered, which is never
 * allowed to mean "this make does not exist".
 */
async function lookupMakeByName(
  cfg: HttpVehicleConfig,
  cookie: string,
  wanted: string,
  vehicleTypeId: string,
): Promise<Picked | null | 'unavailable' | Kicked> {
  const q = encodeURIComponent(wanted);
  const vt = encodeURIComponent(vehicleTypeId);
  const paths = [
    `/lookup/vehicle_makes?search_term=${q}&vehicle_type=${vt}&page=1&page_limit=100`,
    `/lookup/vehicle_makes.json?search_term=${q}&page_limit=100&page=1`,
  ];
  let answered = false;
  for (const path of paths) {
    const r = await readLookup<unknown>(cfg, cookie, path);
    if (r.kind === 'kicked') return KICKED;
    if (r.kind === 'absent' || r.kind === 'transient') continue;
    answered = true;
    const list = pickList(r.data, ['vehicle_makes', 'makes', 'results']);
    if (!list) continue;
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const v = row as Record<string, unknown>;
      const name = str(v['name'] ?? v['text']);
      if (normText(name) !== normText(wanted)) continue;
      const id = str(v['id'] ?? v['value']);
      if (id) return { id, label: name };
    }
  }
  return answered ? null : 'unavailable';
}

/**
 * ANY-tipe policy, ported from rpaSink.pickModelLoose: take the typed model if
 * Turboly has it, otherwise stand in the make's MOST SIMILAR model and record
 * the typed tipe in the order notes. Only a make with genuinely zero models
 * fails — and only after the model lookup answered, because an empty list from a
 * kicked session is what once turned TOYOTA/Avanza into a permanent
 * "make has no models" verdict.
 */
async function resolveModel(
  cfg: HttpVehicleConfig,
  cookie: string,
  form: VehicleForm,
  makeId: string,
  makeLabel: string,
  typed: string,
  what: string,
): Promise<Picked | Kicked> {
  const select = selectFor(form, 'vehicle-model-select', 'vehicle[vehicle_model_id]', /vehicle_model|(^|\W)model/i);
  if (!select?.name) throw new DataError(`${what}: kontrol Model (vehicle model) tidak ada di form Turboly`);
  const q = (typed ?? '').trim();

  // Deliberately NOT reading the form's own <option>s here, unlike the make.
  // The model list is per-make (the page refills it after a make is picked), so
  // anything rendered into a freshly-GET form belongs to some other make —
  // matching "CIVIC" there would file a Toyota under Honda's model id. The
  // lookup below is keyed by vehicle_make and cannot make that mistake.
  if (q) {
    const searched = await lookupModels(cfg, cookie, makeId, q, 1);
    if (searched === KICKED) return KICKED;
    const exact = searched.find((m) => normText(m.label) === normText(q));
    if (exact) return exact;
    // rpaSink clicks the first select2 result without checking exactness; keeping
    // that parity matters more than being cleverer than the proven path.
    const first = searched[0];
    if (first) {
      return { ...first, note: `Tipe diketik "${q}" tidak ada di katalog — model paling mirip dipakai: ${first.label}` };
    }
  }

  const all = await lookupModels(cfg, cookie, makeId, '', 10);
  if (all === KICKED) return KICKED;
  if (!all.length) throw new DataError(`${what}: merk ${makeLabel} belum punya model apa pun di Turboly (tipe diketik "${q || '—'}")`);

  // Most-similar: containment (either direction) outranks fuzzy distance.
  const nq = q.toUpperCase().replace(/\s+/g, ' ').trim();
  let best = all[0]!;
  let bestScore = -1;
  for (const m of all) {
    const ni = m.label.toUpperCase().replace(/\s+/g, ' ').trim();
    const contain = nq && (ni.includes(nq) || nq.includes(ni)) ? 0.95 : 0;
    const score = Math.max(contain, nq ? jaroWinkler(nq, ni) : 0);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return {
    ...best,
    note: q
      ? `Tipe diketik "${q}" tidak ada di katalog — model paling mirip dipakai: ${best.label}`
      : `Tipe kosong — model Turboly dipakai: ${best.label}`,
  };
}

/** The exact endpoint (and paging) sync-catalogs.mjs harvests the model catalog with. */
async function lookupModels(
  cfg: HttpVehicleConfig,
  cookie: string,
  makeId: string,
  searchTerm: string,
  maxPages: number,
): Promise<Picked[] | Kicked> {
  const out: Picked[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const path =
      `/lookup/vehicle_models?search_term=${encodeURIComponent(searchTerm)}&vehicle_type=&vehicle_make=${encodeURIComponent(makeId)}` +
      `&page=${page}&page_limit=100`;
    const data = await lookupJson<unknown>(cfg, cookie, path, 'Cari model kendaraan');
    if (data === KICKED) return KICKED;
    const list = pickList(data, ['vehicle_models', 'models', 'results']);
    if (!list) {
      throw new TransientError(
        'Cari model kendaraan: jawaban /lookup/vehicle_models tidak dikenali — dianggap belum terjawab, dicoba ulang otomatis',
      );
    }
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const v = row as Record<string, unknown>;
      const label = str(v['name'] ?? v['text']);
      const id = str(v['id'] ?? v['value']);
      // Without an id there is nothing to POST — a name-only catalog means this
      // form cannot be filled over HTTP and must go back to the browser.
      if (label && id) out.push({ id, label });
    }
    if (list.length < 100) break;
  }
  return out;
}

// ── create ───────────────────────────────────────────────────────────────────

/**
 * GET the form page. Turboly bounces the first navigation after a (re)login to
 * the dashboard, so a non-sign-in redirect is retried instead of being reported
 * as a missing form.
 */
async function fetchForm(cfg: HttpVehicleConfig, path: string, cookie: string, what: string): Promise<{ html: string; url: string } | Kicked> {
  const url = absUrl(cfg.baseUrl, path);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { redirect: 'manual', headers: { cookie, accept: 'text/html,application/xhtml+xml' } });
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400) {
      if (/\/users\/sign_in/.test(location)) return KICKED;
      if (attempt === 3) {
        throw new TransientError(
          `${what}: buka form kendaraan dialihkan ke ${location || '(tanpa Location)'} 3× — kemungkinan sesi ter-kick, dicoba ulang otomatis`,
        );
      }
      continue;
    }
    const html = await res.text();
    if (isSignInHtml(html)) return KICKED;
    if (isOutage(res.status, html)) {
      throw new TransientError(`${what}: Turboly tidak bisa diakses (HTTP ${res.status}) saat membuka form kendaraan — dicoba ulang otomatis`);
    }
    return { html, url };
  }
  throw new TransientError(`${what}: form kendaraan tidak terbuka — dicoba ulang otomatis`);
}

function ownedBy(row: TurbolyVehicleMatch, customerId: string): boolean {
  return row.customerId != null && row.customerId === customerId;
}

function resultFrom(cfg: HttpVehicleConfig, row: TurbolyVehicleMatch, created: boolean, notes: string[], ownedByOther: TurbolyVehicleMatch | null): HttpVehicleResult {
  return {
    vehicleId: String(row.id),
    vehicleUrl: absUrl(cfg.baseUrl, `/vehicles/${row.id}`),
    created,
    existing: created ? null : row,
    ownedByOther,
    notes: [...notes],
  };
}

/**
 * Create a vehicle for an existing customer: GET /vehicles/new → POST /vehicles.
 *
 * DUPLICATE CREATION IS THIS SYSTEM'S WORST FAILURE MODE, so the plate lookup
 * runs at the top of every attempt and again after any ambiguous POST. The
 * consequence is that an unclear outcome NEVER becomes a second row: either the
 * read-back finds what Turboly wrote, or we fail to review with the plate in the
 * message.
 */
export async function createVehicleHttp(cfg: HttpVehicleConfig, args: HttpVehicleArgs): Promise<HttpVehicleResult> {
  const what = 'Kendaraan';
  const reg = (args.registration ?? '').replace(/\s/g, '').toUpperCase();
  if (!reg) throw new DataError(`${what}: nomor polisi kosong`);
  if (!args.customerId?.trim()) throw new DataError(`${what}: id customer pemilik kosong — kendaraan tidak boleh dibuat tanpa pemilik`);
  const customerId = args.customerId.trim();
  const notes: string[] = [];

  return withCookie(cfg, what, async (cookie): Promise<HttpVehicleResult | Kicked> => {
    notes.length = 0; // a retried cycle re-derives its own notes

    // 1. LOOKUP BEFORE CREATE.
    const before = await lookupPlate(cfg, cookie, reg, what);
    if (before === KICKED) return KICKED;
    const mine = before.find((v) => ownedBy(v, customerId));
    if (mine) return resultFrom(cfg, mine, false, notes, null);
    const other = before[0] ?? null;
    if (other && !args.allowSecondOwnerRow) {
      // The car stays with its original owner; forking it into a second row is
      // the duplicate this whole module exists to avoid.
      return resultFrom(cfg, other, false, notes, other);
    }

    // 2. GET the form.
    const page = await fetchForm(cfg, '/vehicles/new', cookie, what);
    if (page === KICKED) return KICKED;
    const form = vehicleFormOf(page.html, cfg.baseUrl);
    if (!form) {
      const title = collapse(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html)?.[1] ?? '')) || '(tanpa judul)';
      throw new DataError(`${what}: form kendaraan tidak ada di ${page.url} — halaman yang terbuka: "${title}"`);
    }
    // Rails rejects the POST without a token, and the token is bound to the
    // cookie used for THIS GET — never reuse one across sessions.
    if (!form.body.get('authenticity_token')) {
      const meta = /csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(page.html)?.[1];
      if (!meta) throw new DataError(`${what}: authenticity_token tidak ada di form kendaraan — POST pasti ditolak`);
      form.body.set('authenticity_token', meta);
    }

    // 3. Fill.
    if (!setIfPresent(form, 'vehicle_registration', 'vehicle[registration]', /vehicle\[registration\]|registration/i, reg)) {
      throw new DataError(`${what}: kolom nomor polisi (registration) tidak ada di form Turboly`);
    }
    if (!setIfPresent(form, 'select2-input-customer', 'vehicle[customer_id]', /^vehicle\[customer_id\]$|customer_id/i, customerId)) {
      throw new DataError(`${what}: kolom pemilik (customer) tidak ada di form Turboly — kendaraan tanpa pemilik tidak boleh dibuat`);
    }

    // Vehicle type first: it is what the make list is keyed to. Left at Turboly's
    // own default when the label is unknown — rpaSink swallows this failure too.
    const typeLabel = args.vehicleTypeLabel ?? 'Car';
    const typeSelect = selectFor(form, 'vehicle-type-select', 'vehicle[vehicle_type_id]', /vehicle_type/i);
    let vehicleTypeId = typeSelect ? (form.body.get(typeSelect.name) ?? '') : '';
    const typeOption = exactOption(usableOptions(typeSelect), typeLabel);
    if (typeSelect?.name && typeOption) {
      form.body.set(typeSelect.name, typeOption.value);
      vehicleTypeId = typeOption.value;
    }

    const make = await resolveMake(cfg, cookie, form, args, vehicleTypeId, what);
    if (make === KICKED) return KICKED;
    const makeSelect = selectFor(form, 'vehicle-make-select', 'vehicle[vehicle_make_id]', /vehicle_make|(^|\W)make/i);
    form.body.set(makeSelect?.name ?? 'vehicle[vehicle_make_id]', make.id);

    const model = await resolveModel(cfg, cookie, form, make.id, make.label, args.model ?? '', what);
    if (model === KICKED) return KICKED;
    const modelSelect = selectFor(form, 'vehicle-model-select', 'vehicle[vehicle_model_id]', /vehicle_model|(^|\W)model/i);
    form.body.set(modelSelect?.name ?? 'vehicle[vehicle_model_id]', model.id);
    if (model.note) notes.push(model.note);

    const odo = (args.odometer ?? '').trim() || '0';
    if (args.year) setIfPresent(form, 'vehicle_year', 'vehicle[year]', /vehicle\[year\]/i, args.year);
    if (args.color) setIfPresent(form, 'vehicle_color', 'vehicle[color]', /vehicle\[color\]/i, args.color);
    setIfPresent(form, 'vehicle_odometer', 'vehicle[odometer]', /vehicle\[odometer\]/i, odo);
    // Service-reminder defaults, mirroring rpaSink: +5000 km, 3 months (a COUNT
    // of months, not a date).
    setIfPresent(
      form,
      'vehicle_km_next_service_default',
      'vehicle[km_next_service_default]',
      /km_next_service_default/i,
      String((Number(odo) || 0) + 5000),
    );
    setIfPresent(form, 'vehicle_next_service_date_default', 'vehicle[next_service_date_default]', /next_service_date_default/i, '3');

    // 4. POST. redirect:'manual' is load-bearing: the 302 Location is the only
    // place the new vehicle id appears, and following it replaces that evidence
    // with a rendered page (and, for a duplicate plate, with Turboly's bare
    // "rejected (422)" screen — which is shown even though the row WAS created).
    const res = await fetch(form.actionUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
        referer: page.url,
        origin: cfg.baseUrl.replace(/\/+$/, ''),
      },
      body: form.body.toString(),
    });
    const location = res.headers.get('location') ?? '';
    const body = await res.text();

    if (res.status >= 300 && res.status < 400) {
      if (/\/users\/sign_in/.test(location)) return KICKED;
      const id = /\/vehicles\/(\d+)/.exec(location)?.[1];
      if (id) {
        return {
          vehicleId: id,
          vehicleUrl: absUrl(cfg.baseUrl, location),
          created: true,
          existing: null,
          ownedByOther: null,
          notes: [...notes],
        };
      }
      return confirmByReadBack(cfg, cookie, reg, customerId, notes, what, `Turboly mengalihkan ke ${location || '(tanpa Location)'} tanpa nomor kendaraan`);
    }
    if (isSignInHtml(body)) return KICKED;
    if (isOutage(res.status, body)) {
      throw new TransientError(`${what}: Turboly tidak bisa diakses (HTTP ${res.status}) saat menyimpan kendaraan — dicoba ulang otomatis`);
    }
    const inline = extractFormError(body);
    return confirmByReadBack(
      cfg,
      cookie,
      reg,
      customerId,
      notes,
      what,
      inline ? `ditolak Turboly: ${inline}` : `ditolak Turboly (HTTP ${res.status}, tanpa pesan error yang terbaca)`,
    );
  });
}

/**
 * The POST said something we cannot read as success — ask Turboly what actually
 * exists now. This is the only honest way to tell "rejected" from Turboly's
 * duplicate-plate quirk (a 422-looking page over a row that was written), and it
 * is what keeps a retry from becoming a second vehicle.
 */
async function confirmByReadBack(
  cfg: HttpVehicleConfig,
  cookie: string,
  reg: string,
  customerId: string,
  notes: string[],
  what: string,
  why: string,
): Promise<HttpVehicleResult | Kicked> {
  const after = await lookupPlate(cfg, cookie, reg, what);
  if (after === KICKED) return KICKED;
  const mine = after.find((v) => ownedBy(v, customerId));
  if (mine) {
    return {
      vehicleId: String(mine.id),
      vehicleUrl: absUrl(cfg.baseUrl, `/vehicles/${mine.id}`),
      created: true,
      existing: null,
      ownedByOther: null,
      notes: [...notes],
    };
  }
  throw new DataError(`${what} ${reg} gagal dibuat — ${why}`);
}
