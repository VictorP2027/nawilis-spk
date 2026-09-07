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

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
