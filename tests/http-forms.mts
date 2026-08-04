/**
 * Fixture tests for the HTTP customer registration path (httpRegister.ts).
 *
 * These never touch Turboly. Turboly allows ONE SESSION PER USER and live jobs
 * run against it, so the only safe way to prove the form-echo and the response
 * classifier is a saved HTML fixture plus a fake fetch.
 *
 * httpRegister.ts does not export its internals (formBodyFrom, customerFormOf,
 * applyAddressRow, extractFormError, isSignInHtml, isOutage), so everything here
 * goes through the exported registerRetailHttp / registerWholesaleHttp and
 * asserts the bytes they hand to fetch. That is a slower unit but a truer one:
 * the assertion is literally "this is the POST body Turboly would receive".
 *
 * Mongo is real (in-memory) because registerViaForm reads the shared session
 * cookie out of it before anything else — the same document apps/web caches
 * into, so worker and web do not log in against each other.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect, close, getDb } from '@spk/core';
import { registerRetailHttp, registerWholesaleHttp, type HttpRegisterConfig } from '@spk/core/turboly';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(s: string): void { console.log(`\n── ${s} ──`); }
function eq(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

const BASE = 'https://sandbox.turboly.test';
const CFG: HttpRegisterConfig = { baseUrl: BASE, username: 'robot@nawilis.test', password: 'secret' };
const SEED_COOKIE = '_turboly_session=seed';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Rails escapes &, <, >, " and ' when it stores HTML inside an attribute. */
function esc(html: string): string {
  return html
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The cocoon insertion template: one <tr> with the row index standing in as the
 * literal placeholder "new_addresses", carrying its own hidden defaults and the
 * main_address_index RADIO (not a checkbox — that distinction is the whole
 * reason "Main Address must be one" shows up).
 */
const ADDRESS_ROW = `<tr class="nested-fields">
  <td><input type="hidden" value="false" name="customer[addresses_attributes][new_addresses][_destroy]" id="customer_addresses_attributes_new_addresses__destroy" /></td>
  <td><input type="text" name="customer[addresses_attributes][new_addresses][address]" id="customer_addresses_attributes_new_addresses_address" /></td>
  <td><select name="customer[addresses_attributes][new_addresses][country_id]" id="customer_addresses_attributes_new_addresses_country_id"><option value="">-- Country --</option><option value="62" selected="selected">Indonesia</option></select></td>
  <td><input name="customer[addresses_attributes][new_addresses][use_as_main_address]" type="hidden" value="0" /><input type="checkbox" value="1" name="customer[addresses_attributes][new_addresses][use_as_main_address]" id="customer_addresses_attributes_new_addresses_use_as_main_address" /></td>
  <td><input type="radio" name="main_address_index" value="new_addresses" /></td>
</tr>`;

const ADD_ADDRESS_ANCHOR = (template: string): string =>
  `<a href="#" class="btn add_fields" data-association="address" data-associations="addresses" data-association-insertion-node="#list-address tbody" data-association-insertion-method="append" data-association-insertion-template="${template}">Add Address</a>`;

/** GET /customers/new as this tenant renders it, chrome and all. */
const RETAIL_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>New Customer | Turboly</title>
  <meta name="csrf-token" content="META-TOKEN-xyz" />
</head>
<body>
  <form class="navbar-search" action="/search" accept-charset="UTF-8" method="get">
    <input type="text" name="q" id="q" value="" />
    <input type="submit" name="commit" value="Cari" />
  </form>

  <form id="new_customer" class="form-horizontal" action="/customers" accept-charset="UTF-8" method="post">
    <input name="utf8" type="hidden" value="&#x2713;" />
    <input type="hidden" name="authenticity_token" value="FORM-TOKEN-abc123==" />
    <input type="hidden" name="customer[tenant_id]" value="41" />

    <input type="text" name="customer[name]" id="customer_name" value="" />
    <input type="text" name="customer[group_name]" id="customer_group_name" value="" />
    <input type="text" name="customer[phone]" id="customer_phone" value="" />
    <input type="text" name="customer[email]" id="customer_email" value="" />

    <textarea name="customer[note]" id="customer_note">
catatan awal</textarea>

    <select name="customer[title_id]" id="customer_title_id">
      <option value="11">Bapak</option>
      <option value="12">Ibu</option>
    </select>

    <select name="customer[payment_term_id]" id="customer_payment_term_id">
      <option value="0" disabled="disabled">-- Pilih Termin --</option>
      <option value="30">Net 30</option>
      <option value="60">Net 60</option>
    </select>

    <select name="customer[currency]" id="customer_currency">
      <option value="1">USD</option>
      <option value="2" selected="selected">IDR</option>
    </select>

    <select name="customer[store_id]" id="store-id">
      <option value="">-- Pilih Store --</option>
      <option value="7">Nawilis Bekasi</option>
      <option value="9">Nawilis Depok</option>
    </select>

    <select name="customer[service_tax_id]" id="service-tax-id">
      <option value="">-- Pilih --</option>
      <option value="354">Non PPN</option>
      <option value="355">PPN</option>
    </select>

    <select name="customer[customer_wholesale_id]" id="customer-wholesale-id">
      <option value="">-- Tanpa Company --</option>
      <option value="880">PT Sinar Jaya</option>
    </select>

    <select name="customer[locked_group]" id="customer_locked_group" disabled="disabled">
      <option value="99" selected="selected">Locked</option>
    </select>

    <input name="customer[is_active]" type="hidden" value="0" />
    <input type="checkbox" name="customer[is_active]" id="customer_is_active" value="1" />

    <input name="customer[send_wa]" type="hidden" value="0" />
    <input type="checkbox" name="customer[send_wa]" id="customer_send_wa" value="1" checked="checked" />

    <input type="file" name="customer[photo]" id="customer_photo" />
    <input type="button" name="batal" value="Batal" />
    <input type="reset" name="reset_form" value="Reset" />

    <table id="list-address"><tbody></tbody></table>
    ${ADD_ADDRESS_ANCHOR(esc(ADDRESS_ROW))}

    <input type="submit" name="commit" value="Save" class="btn btn-primary" />
  </form>
</body>
</html>`;

/** GET /customers/new?wholesale=1 — different field names for the same concepts. */
const WHOLESALE_PAGE = `<!DOCTYPE html>
<html>
<head><title>New Wholesale Customer | Turboly</title><meta name="csrf-token" content="META-TOKEN-w" /></head>
<body>
  <form id="new_customer" action="/customers" accept-charset="UTF-8" method="post">
    <input type="hidden" name="authenticity_token" value="FORM-TOKEN-wholesale" />
    <input type="hidden" name="customer[wholesale]" value="1" />
    <input type="text" name="customer[name]" id="customer_name" value="" />
    <input type="text" name="customer[group_name]" id="customer_group_name" value="" />
    <input type="text" name="customer[contact_fullname]" id="customer_contact_fullname" value="" />
    <input type="text" name="customer[tax_no]" id="customer_tax_no" value="" />

    <select name="customer[tax_id]" id="tax-id">
      <option value="">-- Pilih --</option>
      <option value="354">Non PPN</option>
      <option value="355">PPN</option>
    </select>

    <select name="customer[currency]" id="customer_currency">
      <option value="2" selected="selected">IDR</option>
    </select>

    <select name="customer[salesperson_id]" id="salesperson-id">
      <option value="">-- Pilih Salesperson --</option>
      <option value="4020">Agus Prasetyo</option>
      <option value="4021">Rina  S</option>
    </select>

    <table id="list-address"><tbody></tbody></table>
    ${ADD_ADDRESS_ANCHOR(esc(ADDRESS_ROW))}
    <input type="submit" name="commit" value="Save" />
  </form>
</body>
</html>`;

const SIGN_IN_PAGE = `<!DOCTYPE html><html><head><title>Sign in | Turboly</title></head><body>
  <div class="alert alert-notice">You need to sign in or sign up before continuing.</div>
  <form action="/users/sign_in" accept-charset="UTF-8" method="post">
    <input type="hidden" name="authenticity_token" value="LOGIN-TOKEN" />
    <input type="email" name="user[email]" id="user_email" />
    <input type="password" name="user[password]" id="user_password" />
    <input type="submit" name="commit" value="Login" />
  </form>
</body></html>`;

/** A rejected save: HTTP 200 re-rendering the form with Bootstrap 2's .alert-error. */
const REJECTED_PAGE = `<!DOCTYPE html><html><head><title>New Customer | Turboly</title></head><body>
  <div class="alert alert-error">
    <a class="close" data-dismiss="alert" href="#">&times;</a>
    2 errors prohibited this customer from being saved: Main Address must be one, Phone has already been taken
  </div>
  ${RETAIL_PAGE}
</body></html>`;

// ── fake Turboly ─────────────────────────────────────────────────────────────

interface Call { method: string; path: string; cookie: string; body: string }

function html(s: string, status = 200): Response {
  return new Response(s, { status, headers: { 'content-type': 'text/html' } });
}
function redirect(location: string): Response {
  return new Response('<html><body>You are being redirected.</body></html>', {
    status: 302,
    headers: { location, 'content-type': 'text/html' },
  });
}

interface Routes {
  /** Page served for GET /customers/new (retail) — defaults to RETAIL_PAGE. */
  retail?: string;
  /** Page served for GET /customers/new?wholesale=1. */
  wholesale?: string;
  /** Response for POST /customers, called once per attempt. */
  post: (n: number) => Response;
}

async function withTurboly<T>(
  routes: Routes,
  fn: () => Promise<T>,
): Promise<{ calls: Call[]; value: T | null; err: Error | null }> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method,
      path: url.startsWith(BASE) ? url.slice(BASE.length) : url,
      cookie: headers['cookie'] ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    if (call.path.startsWith('/users/sign_in')) {
      return method === 'POST'
        ? new Response('', { status: 302, headers: { location: '/dashboard', 'set-cookie': '_turboly_session=fresh; path=/; HttpOnly' } })
        : new Response(SIGN_IN_PAGE, { status: 200, headers: { 'set-cookie': '_turboly_session=pre; path=/' } });
    }
    if (method === 'GET' && call.path.startsWith('/customers/new')) {
      return html(call.path.includes('wholesale=1') ? (routes.wholesale ?? WHOLESALE_PAGE) : (routes.retail ?? RETAIL_PAGE));
    }
    if (method === 'POST' && call.path.startsWith('/customers')) return routes.post(++posts);
    return html(`<html><body>unrouted ${method} ${call.path}</body></html>`, 404);
  }) as typeof globalThis.fetch;
  try {
    return { calls, value: await fn(), err: null };
  } catch (e) {
    return { calls, value: null, err: e as Error };
  } finally {
    globalThis.fetch = real;
  }
}

/** Bodies of every POST that reached /customers, in order. */
function postedBodies(calls: Call[]): URLSearchParams[] {
  return calls.filter((c) => c.method === 'POST' && c.path.startsWith('/customers')).map((c) => new URLSearchParams(c.body));
}

/** The row index applyAddressRow generated, read back off the keys it appended. */
function addressIndexOf(body: URLSearchParams): string | null {
  for (const k of body.keys()) {
    const m = /^customer\[addresses_attributes\]\[([^\]]+)\]/.exec(k);
    if (m?.[1]) return m[1];
  }
  return null;
}

const RETAIL_ARGS = {
  nama: 'Budi Santoso',
  phone: '+62 812-3456-7890',
  alamat: 'Jl. Raya Bekasi No. 12',
  storeTurbolyId: '7',
};

// ── tests ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  await connect(mongod.getUri(), 'httpformstest');
  // The shared session document. Its presence is what keeps a registration to
  // two round trips instead of re-logging in and kicking whoever is mid-form.
  await getDb().collection('turboly_http_session').updateOne(
    { _id: 'cookie' } as never,
    { $set: { cookie: SEED_COOKIE, at: new Date().toISOString() } },
    { upsert: true },
  );

  section('Retail: the POST body echoed back from the form');
  const okRun = await withTurboly(
    { post: () => redirect('/customers/123') },
    () => registerRetailHttp(CFG, RETAIL_ARGS),
  );
  ok(okRun.err === null, `retail register succeeds (${okRun.err?.message ?? 'no error'})`);
  ok(okRun.value?.customerId === '123', `302 to /customers/123 → id 123 (got ${okRun.value?.customerId})`);
  ok(okRun.value?.customerUrl === `${BASE}/customers/123`, 'customerUrl absolutised against baseUrl');
  ok(okRun.calls.filter((c) => c.path.startsWith('/users/sign_in')).length === 0, 'cached cookie reused — no login, no session kick');
  ok(okRun.calls[0]?.cookie === SEED_COOKIE, 'the shared cookie is sent on the form GET');

  const bodies = postedBodies(okRun.calls);
  ok(bodies.length === 1, `exactly one POST to /customers (got ${bodies.length})`);
  const b = bodies[0] ?? new URLSearchParams();

  ok(b.get('authenticity_token') === 'FORM-TOKEN-abc123==', `authenticity_token echoed from the form (got ${b.get('authenticity_token')})`);
  ok(b.get('utf8') === '✓', 'entity-encoded hidden value decoded (utf8=✓)');
  ok(b.get('customer[tenant_id]') === '41', 'unknown hidden field rides along — the point of echoing');
  ok(!b.has('q'), 'controls from the navbar search form are not merged in');

  section('Retail: control-type rules');
  ok(eq(b.getAll('customer[is_active]'), ['0']), `unchecked checkbox: hidden companion only (got ${JSON.stringify(b.getAll('customer[is_active]'))})`);
  ok(eq(b.getAll('customer[send_wa]'), ['0', '1']), `checked checkbox: companion then value, in that order — Rails reads the last (got ${JSON.stringify(b.getAll('customer[send_wa]'))})`);
  ok(!b.has('customer[photo]'), 'file input skipped');
  ok(!b.has('batal'), 'type=button skipped');
  ok(!b.has('reset_form'), 'type=reset skipped');
  ok(eq(b.getAll('commit'), ['Save']), `the single submit is mirrored exactly once (got ${JSON.stringify(b.getAll('commit'))})`);
  ok(!b.has('customer[locked_group]'), 'disabled select not submitted');
  ok(b.get('customer[note]') === 'catatan awal', `textarea posted without its leading newline (got ${JSON.stringify(b.get('customer[note]'))})`);

  section('Retail: select defaults');
  ok(b.get('customer[title_id]') === '11', `nothing selected → first option (got ${b.get('customer[title_id]')})`);
  ok(b.get('customer[payment_term_id]') === '30', `nothing selected → first ENABLED option, disabled placeholder skipped (got ${b.get('customer[payment_term_id]')})`);
  ok(b.get('customer[currency]') === '2', `explicitly selected option wins (IDR, got ${b.get('customer[currency]')})`);
  ok(b.get('customer[customer_wholesale_id]') === '', 'untouched select echoes its own empty default');

  section('Retail: the fields we own');
  ok(b.get('customer[name]') === 'Budi Santoso', 'name set');
  ok(b.get('customer[group_name]') === 'Budi Santoso', 'group_name mirrors the name');
  ok(b.get('customer[phone]') === '081234567890', `phone normalised to LOCAL 0… form — prefix search depends on it (got ${b.get('customer[phone]')})`);
  ok(eq(b.getAll('customer[phone]'), ['081234567890']), 'phone appears once, not appended next to the blank echo');
  ok(eq(b.getAll('customer[store_id]'), ['7']), `store override replaces the echoed default, once (got ${JSON.stringify(b.getAll('customer[store_id]'))})`);
  ok(b.get('customer[service_tax_id]') === '355', `SALES TAX resolved to the PPN option's own value (got ${b.get('customer[service_tax_id]')})`);

  section('Retail: the nested address row');
  const idx = addressIndexOf(b);
  ok(idx !== null && /^\d+$/.test(idx), `address row got a numeric index (got ${idx})`);
  ok(![...b.keys()].some((k) => k.includes('new_addresses')), 'the cocoon placeholder never reaches the wire');
  ok(b.get(`customer[addresses_attributes][${idx}][address]`) === 'Jl. Raya Bekasi No. 12', 'alamat lands in the row');
  ok(eq(b.getAll(`customer[addresses_attributes][${idx}][use_as_main_address]`), ['1']), `row flagged main once, hidden companion collapsed (got ${JSON.stringify(b.getAll(`customer[addresses_attributes][${idx}][use_as_main_address]`))})`);
  ok(b.get(`customer[addresses_attributes][${idx}][_destroy]`) === '0', '_destroy forced to 0');
  ok(b.get(`customer[addresses_attributes][${idx}][country_id]`) === '62', "the row template's own hidden default (country) rides along");
  ok(eq(b.getAll('main_address_index'), [idx]), `EXACTLY ONE main_address_index, equal to the row index (got ${JSON.stringify(b.getAll('main_address_index'))})`);

  section('Retail: a form that already renders an address row');
  // If Turboly ever prefills a blank row, "Main Address must be one" must still hold.
  const prefilled = RETAIL_PAGE.replace(
    '<table id="list-address"><tbody></tbody></table>',
    `<table id="list-address"><tbody>${ADDRESS_ROW.split('new_addresses').join('0').replace('type="radio" name="main_address_index" value="0"', 'type="radio" name="main_address_index" value="0" checked="checked"')}</tbody></table>`,
  );
  const pre = await withTurboly({ retail: prefilled, post: () => redirect('/customers/124') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  const pb = postedBodies(pre.calls)[0] ?? new URLSearchParams();
  ok(pre.err === null, `prefilled-row form still saves (${pre.err?.message ?? 'no error'})`);
  ok(pb.getAll('main_address_index').length === 1, `still exactly one main_address_index (got ${JSON.stringify(pb.getAll('main_address_index'))})`);
  ok(pb.getAll('main_address_index')[0] !== '0', 'the new row, not the prefilled one, is the main address');

  section('Two submit buttons: neither is guessed at');
  const twoSubmits = RETAIL_PAGE.replace(
    '<input type="submit" name="commit" value="Save" class="btn btn-primary" />',
    '<input type="submit" name="commit" value="Save" /><input type="submit" name="commit" value="Save &amp; New" />',
  );
  const two = await withTurboly({ retail: twoSubmits, post: () => redirect('/customers/125') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  const tb = postedBodies(two.calls)[0] ?? new URLSearchParams();
  ok(two.err === null, `Save / Save & New form still posts (${two.err?.message ?? 'no error'})`);
  ok(!tb.has('commit'), `submit inputs are skipped by the echo; ambiguous pair adds none back (got ${JSON.stringify(tb.getAll('commit'))})`);

  section('authenticity_token missing from the form');
  const noToken = RETAIL_PAGE.replace('<input type="hidden" name="authenticity_token" value="FORM-TOKEN-abc123==" />', '');
  const nt = await withTurboly({ retail: noToken, post: () => redirect('/customers/126') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  const ntb = postedBodies(nt.calls)[0] ?? new URLSearchParams();
  ok(nt.err === null, `falls back to the csrf-token meta tag (${nt.err?.message ?? 'no error'})`);
  ok(ntb.get('authenticity_token') === 'META-TOKEN-xyz', `meta token used (got ${ntb.get('authenticity_token')})`);

  section('Response classification');
  const rejected = await withTurboly({ post: () => html(REJECTED_PAGE, 200) }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(rejected.err?.name === 'DataError', `200 + .alert-error → DataError (got ${rejected.err?.name})`);
  ok(rejected.err?.message.includes('Main Address must be one'), `Turboly's own words are preserved: ${JSON.stringify(rejected.err?.message.slice(0, 140))}`);
  ok(rejected.err?.message.includes('Phone has already been taken'), 'the whole error block is carried, not just the first line');
  ok(postedBodies(rejected.calls).length === 1, 'a rejected save is never retried into a second customer');

  const kicked = await withTurboly({ post: () => html(SIGN_IN_PAGE, 200) }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(kicked.err?.name === 'TransientError', `200 sign-in page → TransientError (got ${kicked.err?.name})`);
  ok((kicked.err?.message ?? '').includes('ter-kick'), `operator-facing Indonesian mentions the kick: ${JSON.stringify(kicked.err?.message)}`);
  ok(postedBodies(kicked.calls).length === 2, `one re-login and one replay, then it stops (got ${postedBodies(kicked.calls).length} POSTs)`);
  ok(kicked.calls.some((c) => c.method === 'POST' && c.path.startsWith('/users/sign_in')), 're-login attempted');
  ok(postedBodies(kicked.calls)[1]?.get('authenticity_token') === 'FORM-TOKEN-abc123==', 'the replay re-GETs the form so the token matches the new cookie');
  ok(kicked.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/customers/new'))[1]?.cookie === '_turboly_session=fresh', 'the replay uses the cookie the re-login returned');

  const outage = await withTurboly({ post: () => new Response('', { status: 502 }) }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(outage.err?.name === 'TransientError', `502 with an empty body → TransientError (got ${outage.err?.name})`);
  ok(postedBodies(outage.calls).length === 1, 'an outage is not re-POSTed inside one call');

  const proxy = await withTurboly({ post: () => html('<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>', 502) }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(proxy.err?.name === 'TransientError', `502 proxy page → TransientError, not routed to review (got ${proxy.err?.name})`);

  const nowhere = await withTurboly({ post: () => redirect('/dashboard') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(nowhere.err?.name === 'DataError', `302 without a customer id → DataError (got ${nowhere.err?.name})`);
  ok((nowhere.err?.message ?? '').includes('tidak terkonfirmasi'), 'an ambiguous save is reported, not retried');
  ok(postedBodies(nowhere.calls).length === 1, 'ambiguous save never becomes a second record');

  const kickRedirect = await withTurboly({ post: (n) => (n === 1 ? redirect('/users/sign_in') : redirect('/customers/200')) }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(kickRedirect.err === null && kickRedirect.value?.customerId === '200', `302 to /users/sign_in → re-login and replay, then success (got ${kickRedirect.err?.name ?? kickRedirect.value?.customerId})`);

  section('Form shape problems fail before anything is written');
  const noPpn = RETAIL_PAGE.replace('<option value="355">PPN</option>', '<option value="355">PPN Impor</option>');
  const np = await withTurboly({ retail: noPpn, post: () => redirect('/customers/127') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(np.err?.name === 'DataError', `no PPN option → DataError (got ${np.err?.name})`);
  ok((np.err?.message ?? '').includes('Non PPN'), 'the error lists what the form actually offered');
  ok(postedBodies(np.calls).length === 0, 'nothing is POSTed when the form cannot be filled');

  const noTemplate = RETAIL_PAGE.replace('data-association-insertion-template="', 'data-disabled-template="');
  const ntpl = await withTurboly({ retail: noTemplate, post: () => redirect('/customers/128') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(ntpl.err?.name === 'DataError', `no Add Address template → DataError (got ${ntpl.err?.name})`);
  ok(postedBodies(ntpl.calls).length === 0, 'no POST without an address row');

  const notTheForm = await withTurboly({ retail: '<html><head><title>Dashboard</title></head><body><h1>Dashboard</h1></body></html>', post: () => redirect('/customers/129') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  ok(notTheForm.err?.name === 'DataError', `no customer form on the page → DataError (got ${notTheForm.err?.name})`);
  ok((notTheForm.err?.message ?? '').includes('Dashboard'), 'the error names the page that actually opened');

  section('Wholesale');
  const ws = await withTurboly(
    { post: () => redirect('/customers/900') },
    () => registerWholesaleHttp(CFG, { companyName: 'PT Sinar Jaya', picName: 'Budi Santoso', npwp: '01.234.567.8-901.000', alamat: 'Jl. Industri 8', advisorName: 'Rina S' }),
  );
  const wb = postedBodies(ws.calls)[0] ?? new URLSearchParams();
  ok(ws.err === null, `wholesale register succeeds (${ws.err?.message ?? 'no error'})`);
  ok(ws.calls.some((c) => c.method === 'GET' && c.path === '/customers/new?wholesale=1'), 'the wholesale marker is on the GET');
  ok(wb.get('customer[name]') === 'PT Sinar Jaya' && wb.get('customer[group_name]') === 'PT Sinar Jaya', 'company name in name + group_name');
  ok(wb.get('customer[contact_fullname]') === 'Budi Santoso', 'PIC goes to contact_fullname');
  ok(wb.get('customer[tax_no]') === '01.234.567.8-901.000', 'NPWP goes to tax_no');
  ok(wb.get('customer[tax_id]') === '355', `SALES TAX goes to tax_id = PPN, not the NPWP (got ${wb.get('customer[tax_id]')})`);
  ok(wb.get('customer[salesperson_id]') === '4021', `salesperson matched by visible text despite double spacing (got ${wb.get('customer[salesperson_id]')})`);
  ok(wb.getAll('main_address_index').length === 1, 'wholesale row also gets exactly one main address');

  const badSales = await withTurboly(
    { post: () => redirect('/customers/901') },
    () => registerWholesaleHttp(CFG, { companyName: 'PT X', picName: 'Y', npwp: '0', alamat: 'Jl. Z', advisorName: 'Orang Tidak Ada' }),
  );
  ok(badSales.err?.name === 'DataError', `unknown salesperson → DataError (got ${badSales.err?.name})`);
  ok((badSales.err?.message ?? '').includes('Agus Prasetyo'), 'the error lists the salespeople Turboly offered');
  ok(postedBodies(badSales.calls).length === 0, 'never credits the wrong salesperson by posting anyway');

  section('CHARACTERISATION — double-escaped insertion template (verify live)');
  // Rails escapes once; if this tenant's helper escapes the stored HTML a second
  // time the row parses to nothing and only the fields we force survive. Written
  // down so a live GET of /customers/new can be diffed against it.
  const doubleEscaped = RETAIL_PAGE.replace(esc(ADDRESS_ROW), esc(esc(ADDRESS_ROW)));
  const de = await withTurboly({ retail: doubleEscaped, post: () => redirect('/customers/130') }, () => registerRetailHttp(CFG, RETAIL_ARGS));
  const deb = postedBodies(de.calls)[0] ?? new URLSearchParams();
  const deIdx = addressIndexOf(deb);
  ok(de.err === null, `double-escaped template does not throw (${de.err?.message ?? 'no error'})`);
  ok(deb.get(`customer[addresses_attributes][${deIdx}][address]`) === 'Jl. Raya Bekasi No. 12', 'alamat still posted');
  ok(deb.getAll('main_address_index').length === 1, 'still exactly one main_address_index');
  ok(!deb.has(`customer[addresses_attributes][${deIdx}][country_id]`), "but the row's hidden defaults are LOST — Turboly would reject on Country if it is required");

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);

  await close();
  await mongod.stop();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
