// Scrape Turboly product catalogs into ~/turboly-export CSVs, the same shape
// import-turboly-export.mjs already reads.
//
//   TURBOLY_SCRAPE_USERNAME=… TURBOLY_SCRAPE_PASSWORD=… \
//     node --env-file=.env scripts/scrape-products.mjs
//
// Queries are Ransack index pages (q[sku_cont]= / q[name_cont]=), paginated.
// Hard-learned rules from the vehicle-model scrape apply here too:
//   - stop on an EMPTY page and dedupe by SKU — never trust a page-size claim;
//   - pace requests, because a rate-limited response is an empty-looking page
//     that mimics the end of the list;
//   - a login redirect mid-scrape means another session (the Vercel lookup
//     layer shares this account) kicked ours: re-login and retry the same page.
// Sessions are one-per-user, so this deliberately uses the LOOKUP account, not
// the pusher's — kicking the CI pusher mid-push is how orders fail in public.
const BASE = (process.env.TURBOLY_BASE_URL ?? 'https://sandbox.turboly.com').replace(/\/+$/, '');
const USER = process.env.TURBOLY_SCRAPE_USERNAME;
const PASS = process.env.TURBOLY_SCRAPE_PASSWORD;
if (!USER || !PASS) {
  console.error('set TURBOLY_SCRAPE_USERNAME / TURBOLY_SCRAPE_PASSWORD (the lookup account, NOT the pusher)');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
function grabCookies(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  if (!set.length) return;
  const jar = new Map(cookie.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
  for (const c of set) {
    const kv = c.split(';')[0];
    jar.set(kv.split('=')[0], kv);
  }
  cookie = [...jar.values()].join('; ');
}

async function login(attempt = 1) {
  cookie = '';
  const r1 = await fetch(`${BASE}/users/sign_in`, { redirect: 'manual', headers: { 'user-agent': UA } });
  // Turboly 5xx here is the tenant hiccuping, not a refusal — wait it out.
  if (r1.status >= 500 && attempt < 5) {
    console.log(`  sign-in page HTTP ${r1.status} — retry ${attempt}/4 in ${attempt * 5}s`);
    await sleep(attempt * 5000);
    return login(attempt + 1);
  }
  grabCookies(r1);
  const html = await r1.text();
  const token =
    /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ??
    /csrf-token"[^>]*content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error(`no authenticity_token on sign-in page (HTTP ${r1.status}, ${html.length}b)`);
  const r2 = await fetch(`${BASE}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'user-agent': UA, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'user[email]': USER, 'user[password]': PASS, authenticity_token: token, commit: 'Log in' }),
  });
  grabCookies(r2);
  if (r2.status !== 302) throw new Error(`login not accepted (HTTP ${r2.status}) — wrong credentials?`);
  console.log(`logged in as ${USER}`);
}

/** One Ransack index page; returns rows or 'login' when the session was kicked. */
async function page(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', headers: { 'user-agent': UA, cookie, accept: 'text/html' } });
  grabCookies(res);
  if (res.status === 302) return 'login';
  const html = await res.text();
  // Row shape: <td><a href="/products/12345">SKU</a></td> then sibling cells.
  const rows = [];
  const tr = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = tr.exec(html)) !== null) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim(),
    );
    if (cells.length < 2 || !cells[0]) continue;
    rows.push(cells);
  }
  return rows;
}

/** Paginate one query until an empty page; dedupe by SKU across pages. */
async function scrape(path, label) {
  const bySku = new Map();
  for (let p = 1; p <= 200; p++) {
    let rows = await page(`${path}&page=${p}`);
    if (rows === 'login') {
      console.log(`  [${label}] session kicked at page ${p} — re-login`);
      await login();
      rows = await page(`${path}&page=${p}`);
      if (rows === 'login') throw new Error('still redirected after re-login');
    }
    const before = bySku.size;
    for (const cells of rows) if (/^[A-Z0-9][A-Z0-9-]+$/.test(cells[0])) bySku.set(cells[0], cells);
    console.log(`  [${label}] page ${p}: +${bySku.size - before} (total ${bySku.size})`);
    if (bySku.size === before) break; // empty or all-duplicate page = the end
    await sleep(700);
  }
  return [...bySku.values()];
}

const csvEsc = (s) => (/[",\n]/.test(s ?? '') ? `"${String(s).replace(/"/g, '""')}"` : (s ?? ''));

await login();

// Products index columns: SKU · Name · Product Code · Brand · Type · …
const TARGETS = [
  { file: 'ofl_products.csv', label: 'OFL', path: '/products?utf8=%E2%9C%93&q%5Bsku_cont%5D=OFL-' },
  { file: 'pentil_products.csv', label: 'PENTIL', path: '/products?utf8=%E2%9C%93&q%5Bname_cont%5D=pentil' },
];

const { writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const DIR = process.argv[2] ?? join(process.env.HOME ?? '', 'turboly-export');

for (const t of TARGETS) {
  const rows = await scrape(t.path, t.label);
  const out = ['SKU,Name,Brand,Size,Price,Total Qty'];
  for (const c of rows) out.push([c[0], c[1], c[3] ?? '', '', '', ''].map(csvEsc).join(','));
  writeFileSync(join(DIR, t.file), out.join('\n') + '\n');
  console.log(`${t.file}: ${rows.length} products`);
}
