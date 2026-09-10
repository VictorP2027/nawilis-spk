/**
 * ONE COMPANY, ONE CUSTOMER RECORD.
 *
 * The ERP and the counter disagree about the legal form, never about the name.
 * Comparing raw strings made "PT. ANGKASA PURA" and "ANGKASA PURA" two
 * different customers — and a duplicate in the ERP cannot be merged back.
 *
 * The rule is used for EQUALITY only, never as a prefix test. The tests that
 * matter most are the ones that must NOT match.
 *
 *   npx tsx tests/company-name.mts
 */
import { companyNameKey } from '@spk/core';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (c: boolean, l: string): void => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ FAIL: ${l}`); } };
const same = (a: string, b: string): boolean => companyNameKey(a) === companyNameKey(b) && companyNameKey(a) !== '';

// ── the same company, spelled two ways ───────────────────────────────────
ok(same('PT. ANGKASA PURA LOGISTIK', 'ANGKASA PURA LOGISTIK'), 'PT. dengan titik = tanpa PT');
ok(same('PT ANGKASA PURA LOGISTIK', 'PT. ANGKASA PURA LOGISTIK'), 'titik tidak membedakan');
ok(same('CV SINAR JAYA', 'CV. SINAR JAYA'), 'CV juga');
ok(same('cv sinar jaya', 'CV SINAR JAYA'), 'huruf kecil sama saja');
ok(same('PT  ANGKASA   PURA', 'PT ANGKASA PURA'), 'spasi ganda tidak membedakan');
ok(same('UD BAROKAH', 'BAROKAH'), 'UD juga bentuk hukum');

// ── DIFFERENT companies — these must never merge ─────────────────────────
ok(!same('PT SINAR JAYA', 'PT SINAR JAYA ABADI'), 'nama yang lebih panjang BUKAN perusahaan yang sama');
ok(!same('SUMBER MAKMUR', 'PT SUMBER MAKMUR TBK'), 'Tbk badan hukum lain — tidak digabung');
ok(!same('PT MAJU JAYA', 'PT MAJU JAYA SENTOSA'), 'awalan sama, perusahaan beda');
ok(!same('FRANK', 'FRANKI'), 'orang: FRANK bukan FRANKI');
ok(!same('PT A', 'PT B'), 'nama berbeda tetap berbeda');

// ── people, not companies ────────────────────────────────────────────────
ok(same('SUMI', 'SUMI'), 'nama orang tetap cocok dengan dirinya');
ok(!same('SEPTIAN', 'EPTIAN'), '"SEPTIAN" tidak dipotong jadi "EPTIAN"');
ok(companyNameKey('PTERODAKTIL') === 'PTERODAKTIL', 'PT hanya dipotong kalau berdiri sendiri');
ok(companyNameKey('CVETKOVIC') === 'CVETKOVIC', 'CVETKOVIC utuh');
ok(companyNameKey('UDIN') === 'UDIN', 'UDIN utuh');

// ── edges ────────────────────────────────────────────────────────────────
ok(companyNameKey('') === '', 'kosong tetap kosong');
ok(companyNameKey('PT') === '', 'hanya bentuk hukum → tidak ada inti');
ok(!same('PT', 'CV'), 'dua nama kosong tidak boleh dianggap sama');
ok(companyNameKey('PT PT ANGKASA') === 'PT ANGKASA', 'hanya satu bentuk hukum yang dipotong');

// ── the browser copy must not drift ──────────────────────────────────────
// pickCustomerInSelect2 matches rows INSIDE the page, so it carries its own
// copy of this rule as a string. Two copies of one rule is how a matcher
// quietly stops agreeing with itself, so pin them together.
{
  const src = readFileSync(new URL('../packages/core/src/turboly/rpaSink.ts', import.meta.url), 'utf8');
  const m = /var keyOf = function \(t\) \{([\s\S]*?)\};/.exec(src);
  ok(!!m, 'salinan keyOf ditemukan di rpaSink');
  // The source escapes backslashes for the template literal; undo that to run it.
  const body = (m?.[1] ?? '').replace(/\\\\/g, '\\');
  // eslint-disable-next-line no-new-func
  const browserKey = new Function('t', body) as (t: string) => string;
  const NAMES = [
    'PT. ANGKASA PURA LOGISTIK', 'ANGKASA PURA LOGISTIK', 'CV SINAR JAYA',
    'PT SUMBER MAKMUR TBK', 'SUMBER MAKMUR', 'PTERODAKTIL', 'CVETKOVIC',
    'UDIN', 'SUMI', 'PT', '', 'PT  MAJU   JAYA', 'ud barokah',
  ];
  let drift = 0;
  for (const n of NAMES) if (browserKey(n) !== companyNameKey(n)) { drift++; console.log(`      "${n}": browser="${browserKey(n)}" node="${companyNameKey(n)}"`); }
  ok(drift === 0, `salinan di browser sama persis dengan companyNameKey (${NAMES.length} nama diuji)`);
}

// ── name-only matching must never take a PERSON ──────────────────────────
// Regression, live: an SPK for LANA (+6285781530528) attached to a DIFFERENT
// LANA (628119188661) on SRO/TA12/26090099, because a phone the lookup could
// not answer fell through to a NAME search and "LANA" matched "LANA".
// Wrong customer is worse than a duplicate — the order, the invoice and the
// WhatsApp all go to a stranger. Without phone proof, only a row TURBOLY marks
// as a company may be taken.
{
  const src = readFileSync(new URL('../packages/core/src/turboly/rpaSink.ts', import.meta.url), 'utf8');
  const m = /var isCompany = function \(rowName\) \{([\s\S]*?)\};/.exec(src);
  ok(!!m, 'penjaga isCompany ada di rpaSink');
  const body = (m?.[1] ?? '').replace(/\\\\/g, '\\');
  // eslint-disable-next-line no-new-func
  const isCompany = new Function('rowName', body) as (n: string) => boolean;

  // These may be attached to on a name alone.
  ok(isCompany('PT. ANGKASA PURA LOGISTIK'), 'PT. dikenali sebagai perusahaan');
  ok(isCompany('PT ANGKASA PURA'), 'PT tanpa titik juga');
  ok(isCompany('CV SINAR JAYA'), 'CV juga');
  ok(isCompany('SUMBER MAKMUR TBK'), 'Tbk di belakang juga');
  ok(isCompany('UD BAROKAH'), 'UD juga');
  ok(isCompany('KOPERASI KARYAWAN NAWILIS'), 'koperasi juga');

  // These must NEVER be attached to on a name alone.
  ok(!isCompany('LANA'), 'LANA bukan perusahaan — inilah bug-nya');
  ok(!isCompany('SUMI'), 'SUMI bukan perusahaan');
  ok(!isCompany('BUDI SANTOSO'), 'nama orang lengkap pun bukan');
  ok(!isCompany('PTERODAKTIL'), 'PTERODAKTIL bukan PT');
  ok(!isCompany('CVETKOVIC'), 'CVETKOVIC bukan CV');
  ok(!isCompany('UDIN'), 'UDIN bukan UD');
  // PDAM is a company, but the rule only sees a legal form as a WHOLE word, so
  // it is not detected — and that errs the safe way: the push creates a record
  // rather than risking the wrong one. Only 'PD' standing alone counts.
  ok(!isCompany('PDAM JAYA'), 'PDAM tidak dibaca sebagai PD — aman, bukan sempurna');
  ok(isCompany('PD PASAR JAYA'), 'PD sebagai kata utuh memang dihitung');
  ok(!isCompany(''), 'kosong bukan perusahaan');
}

// ── the whole in-page customer matcher, driven with fake rows ────────────
// Lift the exact string the pusher evaluates in the browser, substitute the
// four interpolated inputs, stub document.querySelectorAll, and run it. This
// is the real matcher, not a copy — so the two-record case can never regress
// silently.
{
  const src = readFileSync(new URL('../packages/core/src/turboly/rpaSink.ts', import.meta.url), 'utf8');
  const start = src.indexOf('var want = ${JSON.stringify(phoneKey)};');
  const end = src.indexOf('return best;', start) + 'return best;'.length;
  ok(start > 0 && end > start, 'blok pencocok customer ditemukan di rpaSink');
  const raw = src.slice(start, end);
  /**
   * `rows` are the drop's rows. A row may be written "TEXT" or "ID|TEXT" — the
   * id is what select2 keeps on the <li>, which the matcher reads to tell two
   * people with one name apart.
   */
  const matcher = (rows: string[], phoneKey: string, nama: string, requireCompany = false, wantId = ''): number => {
    const body = raw
      .replace('${JSON.stringify(phoneKey)}', JSON.stringify(phoneKey))
      .replace("${JSON.stringify((nama ?? '').trim().toUpperCase().replace(/\\s+/g, ' '))}", JSON.stringify(nama.trim().toUpperCase().replace(/\s+/g, ' ')))
      .replace("${JSON.stringify(companyNameKey(nama ?? ''))}", JSON.stringify(companyNameKey(nama)))
      .replace('${JSON.stringify(requireCompany)}', JSON.stringify(requireCompany))
      .replace('${JSON.stringify(wantId)}', JSON.stringify(wantId))
      .replace(/\\\\/g, '\\');
    const fakeDoc = {
      querySelectorAll: () => rows.map((r) => {
        const bar = r.indexOf('|');
        const id = bar > 0 ? r.slice(0, bar) : '';
        return {
          innerText: bar > 0 ? r.slice(bar + 1) : r,
          className: 'select2-result',
          getAttribute: (k: string) => (k === 'data-select2-id' && id ? id : null),
        };
      }),
    };
    // eslint-disable-next-line no-new-func
    return new Function('document', body) (fakeDoc) as number;
  };

  // The live case, verbatim from the debug run of 01M1ZWK89.
  const AGNESYA = [
    'AGNESYA DEWI 6287779174377 PALSIGUNUNG 10/03 TUGU CIMANGGIS DEPOK, Tug',
    'AGNESYA DEWI T 6287779174377 Indonesia',
  ];
  ok(matcher(AGNESYA, '87779174377', 'AGNESYA DEWI T') === 1, 'dua record satu nomor: yang NAMANYA cocok yang dipilih (B1390ZOE)');
  ok(matcher(AGNESYA, '87779174377', 'AGNESYA DEWI') === 0, 'dan sebaliknya, kalau yang diminta memang AGNESYA DEWI');
  ok(matcher(AGNESYA, '87779174377', 'ORANG LAIN') === 0, 'nama tak cocok → jatuh ke digit saja, perilaku lama (baris pertama)');
  ok(matcher(AGNESYA, '', 'AGNESYA DEWI T') === 1, 'tanpa nomor, nama persis tetap identitas');
  ok(matcher(AGNESYA, '', 'LANA', true) === -1, 'tanpa nomor, orang biasa tidak boleh diambil (LANA)');
  ok(matcher(['PT ANGKASA PURA LOGISTIK 0215551234 Jakarta'], '', 'ANGKASA PURA LOGISTIK', true) === 0, 'tanpa nomor, perusahaan boleh diambil lewat inti nama');
  ok(matcher(['FRANKI 6281200000000'], '81200000000', 'FRANK') === 0, 'digit cocok, nama beda → tetap dipilih lewat digit (perilaku lama)');
  ok(matcher(['FRANKI'], '', 'FRANK') === -1, 'tanpa digit, FRANK tidak boleh mengambil FRANKI');
  ok(matcher([], '87779174377', 'AGNESYA DEWI T') === -1, 'tidak ada baris → -1');

  // ── the plate names the owner: identity, never the namesake ────────────
  // Live, 10 Sep: F1125EG is registered to EMILY, who has no phone in Turboly.
  // Turboly holds TWO customers called EMILY — 4833784 (with a phone) and
  // 4911782 (the owner) — and the pusher took the first. The car was not hers,
  // so the vehicle add was refused and the SPK died as "sudah terdaftar atas
  // customer LAIN".
  const EMILYS = ['4833784|EMILY 6281211228081', '4911782|EMILY'];
  ok(matcher(EMILYS, '', 'EMILY') === 0, 'tanpa id: perilaku lama — baris pertama (inilah bug F1125EG)');
  ok(matcher(EMILYS, '', 'EMILY', false, '4911782') === 1, 'dengan id pemilik: EMILY yang BENAR yang dipilih');
  ok(matcher(EMILYS, '', 'EMILY', false, '4833784') === 0, 'dan id yang lain memilih baris yang lain');
  ok(matcher(EMILYS, '', 'EMILY', false, '4999999') === -1, 'pemilik tidak ada di daftar → tidak mengambil siapa pun');
  // 30 people share this name on live. Without the id every one of them is a
  // coin flip; with it, only the right one is reachable.
  const ANDRES = ['4757876|ANDRE 6282113295585', '4758040|ANDRE 6282125020101', '4786084|ANDRE'];
  ok(matcher(ANDRES, '', 'ANDRE', false, '4786084') === 2, 'ANDRE yang tanpa nomor pun bisa dipilih lewat id');
  ok(matcher(ANDRES, '', 'ANDRE', false, '') === 0, 'tanpa id tetap baris pertama — tidak ada perubahan perilaku');
  // A phone match is still identity; the id only decides between namesakes.
  ok(matcher(['4757876|ANDRE 6282113295585', '4758040|ANDRE 6282125020101'], '82125020101', 'ANDRE', false, '4758040') === 1,
    'nomor dan id sepakat → baris itu juga');
  // Rows this build cannot identify must behave exactly as before.
  ok(matcher(['EMILY 6281211228081', 'EMILY'], '', 'EMILY', false, '4911782') === 0,
    'id tidak terbaca di baris → jatuh ke perilaku lama, bukan menolak semua');
}

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
