import { getDb } from '../mongo.js';
import { e164Phone, localPhone } from '../indonesia.js';
import { DataError, TransientError } from './rpaSink.js';

/**
 * Customer registration over plain HTTP — the seconds-not-minutes replacement
 * for the browser flow in flowSink.ts.
 *
 * Two reasons it exists. Speed: the browser path burns ~2 minutes, nearly all
 * of it runner cold start and fixed waits, and the owner watched his own
 * registration sit at "Robot sedang mendaftarkan..." for three minutes. Safety:
 * Turboly allows ONE SESSION PER USER, so every second the robot holds a
 * half-filled form is a second in which a human login, the hourly catalog sync
 * or the web app's prefill can kick it and force a restart. Two round trips
 * shrink that collision window by roughly 50x.
 *
 * There is no jsdom in this package, so every "parse" here is a focused regular
 * expression over the HTML string plus a small forward scan. That is only safe
 * because Rails escapes &, <, >, " and ' inside attribute values, so no tag body
 * ever contains a raw '>' — do not relax the [^>]* patterns to something
 * cleverer without checking that assumption first.
 */

export interface HttpRegisterConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface HttpRetailArgs {
  nama: string;
  phone: string;
  alamat: string;
  /** Turboly store id (the native option value), not the store name. */
  storeTurbolyId?: string | null;
  /** Link to a wholesale company by visible name — only used when companyId is absent. */
  companyName?: string | null;
  /** Link to a wholesale company by id: the id registerWholesaleHttp just returned. */
  companyId?: string | null;
}

export interface HttpWholesaleArgs {
  companyName: string;
  picName: string;
  npwp: string;
  alamat: string;
  advisorName: string;
}

export interface HttpRegisterResult {
  customerId: string | null;
  customerUrl: string;
}

// ── HTML scanning ────────────────────────────────────────────────────────────

type Attrs = Record<string, string>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', hellip: '…',
};

/**
 * Attribute values arrive escaped, and the address-row template arrives escaped
 * TWICE (a chunk of HTML stored inside an attribute), so this runs once per
 * nesting level rather than trying to be exhaustive about named entities.
 */
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

/** Comparison key for option text / salesperson names: case- and space-insensitive. */
function normText(s: string): string {
  return collapse(stripTags(s)).toLowerCase();
}

interface ParsedOption { value: string; text: string; selected: boolean; disabled: boolean }
interface ParsedSelect { name: string; id: string; multiple: boolean; options: ParsedOption[] }

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

function selectsIn(fragment: string): ParsedSelect[] {
  const out: ParsedSelect[] = [];
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const a = attrsOf(m[1] ?? '');
    out.push({
      name: a['name'] ?? '',
      id: a['id'] ?? '',
      multiple: 'multiple' in a,
      options: optionsOf(m[2] ?? ''),
    });
  }
  return out;
}

/** Walk input/select/textarea in DOCUMENT ORDER — order carries meaning (see formBodyFrom). */
function eachControl(
  fragment: string,
  visit: (kind: 'input' | 'select' | 'textarea', attrs: Attrs, inner: string) => void,
): void {
  const re = /<(input|select|textarea)\b([^>]*)>/gi;
  const lower = fragment.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const kind = (m[1] ?? '').toLowerCase() as 'input' | 'select' | 'textarea';
    const attrs = attrsOf(m[2] ?? '');
    if (kind === 'input') {
      visit(kind, attrs, '');
      continue;
    }
    const close = lower.indexOf(`</${kind}>`, re.lastIndex);
    const inner = close === -1 ? '' : fragment.slice(re.lastIndex, close);
    visit(kind, attrs, inner);
    // Options and textarea text hold no further controls; skipping past them
    // keeps a stray "<input" inside placeholder text from being submitted.
    if (close !== -1) re.lastIndex = close + kind.length + 3;
  }
}

/**
 * Seed the POST body with what a browser would actually send for this exact
 * form, then let callers override the handful of fields we own. Echoing beats a
 * hardcoded field map: Turboly can add, rename or reorder fields (hidden tenant
 * flags, the wholesale marker) and this still posts them.
 *
 * Order matters and append() preserves it: Rails emits a hidden `name=0` input
 * immediately before every checkbox, and reads the LAST value for that name.
 */
function formBodyFrom(fragment: string): URLSearchParams {
  const body = new URLSearchParams();
  eachControl(fragment, (kind, a, inner) => {
    const name = a['name'];
    if (!name) return;
    if ('disabled' in a) return; // browsers never submit a disabled control
    if (kind === 'textarea') {
      body.append(name, decodeEntities(inner).replace(/^\r?\n/, ''));
      return;
    }
    if (kind === 'select') {
      const opts = optionsOf(inner);
      if ('multiple' in a) {
        for (const o of opts) if (o.selected && !o.disabled) body.append(name, o.value);
        return;
      }
      // No option marked selected → the browser selects the first enabled one.
      const chosen = opts.filter((o) => o.selected && !o.disabled).pop() ?? opts.find((o) => !o.disabled);
      if (chosen) body.append(name, chosen.value);
      return;
    }
    const type = (a['type'] ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') return;
    if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) return;
    body.append(name, a['value'] ?? (type === 'checkbox' || type === 'radio' ? 'on' : ''));
  });
  return body;
}

/**
 * The single Save button, mirrored the way a click would send it. Skipped when
 * the form offers several (Save / Save & New …): we cannot know which one the
 * flow means, and picking wrong changes what the controller does after saving.
 */
function primarySubmit(fragment: string): { name: string; value: string } | null {
  const found: Array<{ name: string; value: string }> = [];
  eachControl(fragment, (kind, a) => {
    if (kind !== 'input') return;
    if ((a['type'] ?? '').toLowerCase() !== 'submit') return;
    const name = a['name'];
    if (name) found.push({ name, value: a['value'] ?? '' });
  });
  return found.length === 1 ? (found[0] ?? null) : null;
}

interface CustomerForm {
  /** Whole page — the Add Address anchor can sit outside the <form>. */
  page: string;
  /** Inner HTML of the customer form only. */
  region: string;
  actionUrl: string;
  body: URLSearchParams;
  selects: ParsedSelect[];
}

/**
 * Pick the customer <form>. Scored by how many customer[...] controls each form
 * region holds rather than by action/id, because the page also carries the
 * search and sign-out forms, and modals bring their own.
 */
function customerFormOf(page: string, baseUrl: string): CustomerForm | null {
  const re = /<form\b([^>]*)>/gi;
  const lower = page.toLowerCase();
  let best: { score: number; region: string; action: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page)) !== null) {
    const a = attrsOf(m[1] ?? '');
    const end = lower.indexOf('</form>', re.lastIndex);
    const region = page.slice(re.lastIndex, end === -1 ? page.length : end);
    const score = (region.match(/name=["']customer\[/g) ?? []).length;
    if (score > 0 && (!best || score > best.score)) best = { score, region, action: a['action'] ?? '' };
  }
  if (!best) return null;
  const body = formBodyFrom(best.region);
  const submit = primarySubmit(best.region);
  if (submit) body.append(submit.name, submit.value);
  return {
    page,
    region: best.region,
    actionUrl: absUrl(baseUrl, best.action || '/customers'),
    body,
    selects: selectsIn(best.region),
  };
}

function absUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Override a field. set() collapses Rails' hidden-companion pair to one value,
 * which is exactly what a checked checkbox posts (Rails reads the last value).
 */
function setField(body: URLSearchParams, name: string, value: string): void {
  body.set(name, value);
}

function findSelect(form: CustomerForm, wantedName: string, idPattern: RegExp): ParsedSelect | null {
  return (
    form.selects.find((s) => s.name === wantedName) ??
    form.selects.find((s) => idPattern.test(s.id) || idPattern.test(s.name)) ??
    null
  );
}

/** Exact option match, case- and whitespace-insensitive. Never "the first option". */
function pickOptionByText(select: ParsedSelect, wanted: string): ParsedOption | null {
  const want = normText(wanted);
  if (!want) return null;
  return select.options.find((o) => normText(o.text) === want) ?? null;
}

function optionList(select: ParsedSelect | null): string {
  const texts = (select?.options ?? []).map((o) => o.text).filter((t) => t.length > 0).slice(0, 12);
  return texts.length ? texts.join(', ') : '(kosong)';
}

// ── the pieces the forms get wrong most often ────────────────────────────────

/**
 * SALES TAX = PPN. The control has a different name on each form
 * (customer[tax_id] on wholesale, customer[service_tax_id] on retail) and
 * customer[tax_no] next to it is the NPWP, not this — so the select is found by
 * the fact that it OFFERS a "PPN" option, with the per-form name only as a
 * tie-break. Posting the option's own value keeps working when the tenant's
 * PPN id changes (it is 355 today, on this tenant only).
 */
function applySalesTaxPPN(form: CustomerForm, preferredName: string, what: string): void {
  const withPpn = form.selects.filter((s) => s.name && s.options.some((o) => normText(o.text) === 'ppn'));
  const select =
    withPpn.find((s) => s.name === preferredName) ??
    withPpn.find((s) => /tax/i.test(s.name) || /tax/i.test(s.id)) ??
    withPpn[0];
  if (!select) {
    const taxish = form.selects.find((s) => /tax/i.test(s.name) || /tax/i.test(s.id)) ?? null;
    throw new DataError(
      `${what}: SALES TAX tidak bisa diset ke PPN — pilihan "PPN" tidak ada di form Turboly. Pilihan yang terlihat: ${optionList(taxish)}`,
    );
  }
  const ppn = select.options.find((o) => normText(o.text) === 'ppn');
  if (!ppn) throw new DataError(`${what}: SALES TAX tidak bisa diset ke PPN. Pilihan: ${optionList(select)}`);
  setField(form.body, select.name, ppn.value);
}

/** Currency stays IDR. The form defaults to it; this only repairs a changed default. */
function applyCurrencyIDR(form: CustomerForm): void {
  const select = findSelect(form, 'customer[currency]', /currency|mata.?uang/i);
  if (!select?.name) return;
  const current = form.body.get(select.name) ?? '';
  const chosen = select.options.find((o) => o.value === current);
  if (chosen && /idr|rupiah/i.test(`${chosen.text} ${chosen.value}`)) return;
  const idr = select.options.find((o) => /idr|rupiah/i.test(`${o.text} ${o.value}`));
  if (idr) setField(form.body, select.name, idr.value);
}

/**
 * Address row. There is no plain address field on the page: "Add Address" is an
 * <a class="add_fields"> whose data-association-insertion-template attribute
 * carries the whole <tr class='nested-fields'> that the browser appends, with a
 * placeholder standing in for the row index. We do exactly what that JS does —
 * decode the template, swap the placeholder for a fresh numeric index, then
 * parse the resulting row like any other form fragment so its own hidden
 * defaults (country, address type, _destroy) ride along.
 *
 * Turboly rejects the save with "Main Address must be one" unless exactly one
 * row is main, and the control that decides it is a RADIO named
 * main_address_index whose value is the row index — not a checkbox. That single
 * fact is the most likely way this whole function fails.
 */
function applyAddressRow(form: CustomerForm, alamat: string, what: string): void {
  const template = addressTemplateOf(form.page, form.region);
  if (!template) {
    throw new DataError(
      `${what}: kontrol "Add Address" (template baris alamat) tidak ada di form Turboly — alamat tidak bisa diisi`,
    );
  }
  // The placeholder is read back out of the template's own field names rather
  // than assumed to be cocoon's "new_addresses": a gem swap would rename it.
  const placeholder = /addresses_attributes\]\[([^\][]+)\]/.exec(template)?.[1];
  if (!placeholder) {
    throw new DataError(`${what}: template baris alamat tidak dikenali (tidak ada addresses_attributes) — alamat tidak bisa diisi`);
  }
  const index = String(Date.now()); // same shape of index the page's own JS generates
  const row = template.split(placeholder).join(index);

  const rowBody = formBodyFrom(row);
  const prefix = `customer[addresses_attributes][${index}]`;
  const addressField = [...rowBody.keys()].find((k) => k.startsWith(prefix) && /\[address\]$/.test(k)) ?? `${prefix}[address]`;
  rowBody.set(addressField, alamat);
  // Consistency between the row flag and the radio: Turboly's JS sets both, and
  // a row flagged main without the radio still trips "Main Address must be one".
  rowBody.set(`${prefix}[use_as_main_address]`, '1');
  if (rowBody.has(`${prefix}[_destroy]`)) rowBody.set(`${prefix}[_destroy]`, '0');
  for (const [k, v] of rowBody.entries()) {
    if (k === 'main_address_index') continue; // handled below, once, for the whole form
    form.body.append(k, v);
  }

  // Prefer the radio's own value from the substituted template; fall back to the
  // index we generated. set() (not append) guarantees exactly ONE main address.
  const radioValue = controlValue(row, 'main_address_index') ?? index;
  form.body.set('main_address_index', radioValue);
}

/** The Add Address template, preferring the anchor that targets the address table. */
function addressTemplateOf(page: string, region: string): string | null {
  const candidates: Array<{ node: string; template: string }> = [];
  for (const html of [region, page]) {
    const re = /<a\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const a = attrsOf(m[1] ?? '');
      const template = a['data-association-insertion-template'];
      if (template) candidates.push({ node: a['data-association-insertion-node'] ?? '', template });
    }
    if (candidates.length) break; // the form's own anchor wins over anything in a modal
  }
  return (
    candidates.find((c) => /list-address/i.test(c.node))?.template ??
    candidates.find((c) => /addresses_attributes/.test(c.template))?.template ??
    null
  );
}

/** Value attribute of a named control inside a fragment, checked or not. */
function controlValue(fragment: string, name: string): string | null {
  const hits: string[] = [];
  eachControl(fragment, (_kind, a) => {
    const value = a['value'];
    if (a['name'] === name && value !== undefined) hits.push(value);
  });
  return hits[0] ?? null;
}

// ── session ──────────────────────────────────────────────────────────────────

const SESSION_COLLECTION = 'turboly_http_session';

/**
 * Fold a response's Set-Cookie into the jar, newest value winning per name.
 * A browser does this for free; skipping it is what broke the CSRF token,
 * since this app rotates its session cookie on every single response.
 */
function mergeCookies(current: string, res: Response): string {
  const fresh = cookiesFrom(res);
  if (!fresh) return current;
  const jar = new Map<string, string>();
  for (const part of `${current}; ${fresh}`.split(';')) {
    const kv = part.trim();
    if (!kv) continue;
    const eq = kv.indexOf('=');
    if (eq > 0) jar.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookiesFrom(res: Response): string {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/**
 * The SAME document apps/web/lib/turbolyLookup.ts caches into, on purpose: one
 * session per user means the worker and the web app must share a cookie instead
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

/** Devise form login, mirroring the web app's working implementation. */
async function login(cfg: HttpRegisterConfig): Promise<string> {
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

/** Turboly down or in front of a proxy error page — retry, never route to review. */
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

function kickedError(what: string): TransientError {
  return new TransientError(
    `${what}: sesi Turboly ter-kick oleh login lain — data belum tersimpan, dicoba ulang otomatis`,
  );
}

// ── request steps ────────────────────────────────────────────────────────────

/**
 * GET the form page. Turboly bounces the first navigation after a (re)login to
 * the dashboard, so a non-sign-in redirect is retried instead of being reported
 * as a missing form.
 */
async function fetchForm(
  cfg: HttpRegisterConfig,
  path: string,
  cookie: string,
  what: string,
): Promise<{ html: string; url: string; cookie: string } | Kicked> {
  const url = absUrl(cfg.baseUrl, path);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { cookie, accept: 'text/html,application/xhtml+xml' },
    });
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
      throw new TransientError(
        `${what}: Turboly sedang tidak bisa diakses (HTTP ${res.status}) saat membuka form — dicoba ulang otomatis`,
      );
    }
    // Turboly re-issues _tbshop on EVERY response, and the per-form CSRF token
    // belongs to the session that response returned — posting with the cookie
    // we sent INTO the GET made Rails answer 422 with no error text at all.
    return { html, url, cookie: mergeCookies(cookie, res) };
  }
  throw new TransientError(`${what}: form Turboly tidak terbuka — dicoba ulang otomatis`);
}

/**
 * POST the filled form. redirect:'manual' is load-bearing: the 302 Location is
 * the ONLY place the new customer id appears, and following it would replace
 * that evidence with the rendered customer page.
 */
async function postCustomer(
  cfg: HttpRegisterConfig,
  cookie: string,
  form: CustomerForm,
  referer: string,
  what: string,
): Promise<HttpRegisterResult | Kicked> {
  const res = await fetch(form.actionUrl, {
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
  const location = res.headers.get('location') ?? '';
  const body = await res.text();

  if (res.status >= 300 && res.status < 400) {
    if (/\/users\/sign_in/.test(location)) return KICKED;
    const id = /\/(?:customers|retail_customers|wholesale_customers)\/(\d+)/.exec(location)?.[1];
    if (id) return { customerId: id, customerUrl: absUrl(cfg.baseUrl, location) };
    // Saved-or-not is genuinely unknown here, and an automatic retry would risk
    // a second customer — fail loudly to review instead.
    throw new DataError(
      `${what}: simpan tidak terkonfirmasi — Turboly mengalihkan ke ${location || '(tanpa Location)'} tanpa nomor customer`,
    );
  }
  if (isSignInHtml(body)) return KICKED;
  if (isOutage(res.status, body)) {
    throw new TransientError(
      `${what}: Turboly sedang tidak bisa diakses (HTTP ${res.status}) saat menyimpan — data belum tersimpan, dicoba ulang otomatis`,
    );
  }
  const inline = extractFormError(body);
  throw new DataError(
    `${what} ditolak Turboly${inline ? `: ${inline}` : ` (HTTP ${res.status}, tanpa pesan error yang terbaca)`}`,
  );
}

/**
 * GET → fill → POST, with ONE re-login. A logged-out response is proof nothing
 * was written, so replaying the whole cycle cannot duplicate a customer; the
 * authenticity token is bound to the session cookie, which is why the GET is
 * replayed too rather than just the POST.
 */
async function registerViaForm(
  cfg: HttpRegisterConfig,
  formPath: string,
  what: string,
  apply: (form: CustomerForm) => void,
): Promise<HttpRegisterResult> {
  let cookie = (await cachedCookie(cfg.username)) ?? (await login(cfg));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await fetchForm(cfg, formPath, cookie, what);
    if (page === KICKED) {
      if (attempt === 2) break;
      cookie = await login(cfg);
      continue;
    }
    const form = customerFormOf(page.html, cfg.baseUrl);
    if (!form) {
      const title = collapse(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html)?.[1] ?? '')) || '(tanpa judul)';
      throw new DataError(`${what}: form customer tidak ada di ${page.url} — halaman yang terbuka: "${title}"`);
    }
    // Rails rejects the POST without a token, and the token is bound to the
    // cookie used for THIS GET — never reuse one across sessions.
    if (!form.body.get('authenticity_token')) {
      const meta = /csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(page.html)?.[1];
      if (!meta) throw new DataError(`${what}: authenticity_token tidak ada di form Turboly — POST pasti ditolak`);
      form.body.set('authenticity_token', meta);
    }
    apply(form);
    // The POST must ride the session the GET handed back, not the one we sent in.
    cookie = page.cookie;
    await saveCookie(cookie, cfg.username).catch(() => {});
    const out = await postCustomer(cfg, cookie, form, page.url, what);
    if (out === KICKED) {
      if (attempt === 2) break;
      cookie = await login(cfg);
      continue;
    }
    return out;
  }
  throw kickedError(what);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Retail customer. The phone is written in E.164, "+62812…" — one spelling
 * across the SPK, Mongo, WhatsApp and Turboly.
 *
 * READ THIS BEFORE CHANGING IT EITHER WAY. Turboly's select2 lookup
 * (/lookup/customers.json) CANNOT match a phone beginning with "+": measured
 * 2026-08-11, "08" returns 100 customers and "+62" returns none, while a
 * customer stored as "+6281188009568" sits in the same tenant. Writing E.164
 * without fixing the lookup made every new customer unfindable, and the next
 * visit created them again — B126JLU and S1234SUP both did.
 *
 * What makes E.164 safe is that identity no longer depends on that endpoint.
 * The customers LIST filter q[phone_cont] matches on the digits alone, so one
 * query on the canonical key finds a record stored "0812…", "62812…" or
 * "+62812…" alike. See findCustomerByPhoneAnyFormat.
 *
 * No duplicate guard lives here — dedupe by phone BEFORE calling, the way
 * flowSink.registerRetailCustomer does.
 */
export async function registerRetailHttp(cfg: HttpRegisterConfig, args: HttpRetailArgs): Promise<HttpRegisterResult> {
  const what = 'Customer Retail';
  const phone = e164Phone(args.phone);
  return registerViaForm(cfg, '/customers/new', what, (form) => {
    setField(form.body, 'customer[name]', args.nama);
    setField(form.body, 'customer[group_name]', args.nama); // Turboly wants the group mirroring the name
    setField(form.body, 'customer[phone]', phone);
    applyAddressRow(form, args.alamat, what);
    applySalesTaxPPN(form, 'customer[service_tax_id]', what);
    applyCurrencyIDR(form);

    if (args.storeTurbolyId) {
      const store = findSelect(form, 'customer[store_id]', /store|cabang|location/i);
      if (!store?.name) {
        throw new DataError(`${what}: kontrol Store tidak ada di form Turboly (store id ${args.storeTurbolyId})`);
      }
      setField(form.body, store.name, args.storeTurbolyId);
    }

    if (args.companyId || args.companyName) {
      const link = findSelect(form, 'customer[customer_wholesale_id]', /wholesale|company|perusahaan/i);
      if (!link?.name) {
        throw new DataError(`${what}: kontrol Company (link ke wholesale) tidak ada di form Turboly`);
      }
      if (args.companyId) {
        setField(form.body, link.name, args.companyId);
      } else {
        const opt = pickOptionByText(link, args.companyName ?? '');
        if (!opt) {
          throw new DataError(
            `${what}: perusahaan "${args.companyName}" tidak ada di daftar Company Turboly. Pilihan: ${optionList(link)}`,
          );
        }
        setField(form.body, link.name, opt.value);
      }
    }
  });
}

/**
 * Wholesale company. Corporate registration is company FIRST, then the linked
 * retail customer via registerRetailHttp({ companyId: <this result> }) — the
 * company save is the irreversible half, so guard it with a name dedupe before
 * calling, the way flowSink does.
 */
export async function registerWholesaleHttp(
  cfg: HttpRegisterConfig,
  args: HttpWholesaleArgs,
): Promise<HttpRegisterResult> {
  const what = 'Customer Wholesale';
  return registerViaForm(cfg, '/customers/new?wholesale=1', what, (form) => {
    setField(form.body, 'customer[name]', args.companyName);
    setField(form.body, 'customer[group_name]', args.companyName);
    // PIC is "Contact Fullname"; NPWP is tax_no (NOT tax_id, which is Sales Tax).
    setField(form.body, 'customer[contact_fullname]', args.picName);
    setField(form.body, 'customer[tax_no]', args.npwp);
    applyAddressRow(form, args.alamat, what);
    applySalesTaxPPN(form, 'customer[tax_id]', what);
    applyCurrencyIDR(form);

    // "* Salesperson" is required here. Its POST name is read off the form
    // (the id is salesperson-id, but the name is not the id), and a miss fails
    // loudly: crediting the wrong salesperson is worse than not registering.
    const sales = findSelect(form, 'customer[salesperson_id]', /salesperson|sales.?person|advisor/i);
    if (!sales?.name) {
      throw new DataError(`${what}: kontrol Salesperson tidak ada di form Turboly`);
    }
    const opt = pickOptionByText(sales, args.advisorName);
    if (!opt) {
      throw new DataError(
        `${what}: Salesperson "${args.advisorName || '(kosong)'}" tidak ada di daftar Turboly. Pilihan: ${optionList(sales)}`,
      );
    }
    setField(form.body, sales.name, opt.value);
  });
}
