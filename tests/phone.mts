/**
 * THE FORM AND THE SERVER MUST AGREE ON WHAT A PHONE NUMBER IS.
 *
 * A landline fix went into the server and into the SPK form, and the Cek n Go
 * form kept its own mobile-only copy of the rule — so the same office number
 * was accepted on one form and refused on the other, and only a person at a
 * counter could discover it.
 *
 * This reads the RULE OUT OF BOTH FORMS and runs it against the same numbers as
 * the server's parseWa. It fails the moment one of them drifts again.
 *
 *   npx tsx tests/phone.mts
 */
import { readFileSync } from 'node:fs';
import { parseWa } from '@spk/core';

let passed = 0;
let failed = 0;
const ok = (cond: unknown, msg: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
};

/** Pull `const waOk = <expr>;` out of a form and turn it into a function. */
function formRule(file: string): (national: string) => boolean {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const m = /const waOk = ([^;]+);/.exec(src);
  if (!m) throw new Error(`tidak menemukan aturan waOk di ${file}`);
  // eslint-disable-next-line no-new-func
  return new Function('waNat', `return ${m[1]};`) as (n: string) => boolean;
}

const CASES: Array<{ raw: string; national: string; valid: boolean; what: string }> = [
  { raw: '08123456789', national: '8123456789', valid: true, what: 'HP biasa' },
  { raw: '+628123456789', national: '8123456789', valid: true, what: 'HP dengan +62' },
  { raw: '+622155512345', national: '2155512345', valid: true, what: 'nomor kantor Jakarta (+6221)' },
  { raw: '02155512345', national: '2155512345', valid: true, what: 'nomor kantor ditulis 021' },
  { raw: '0315551234', national: '315551234', valid: true, what: 'nomor kantor Surabaya (031)' },
  { raw: '+622212345', national: '2212345', valid: false, what: 'nomor kantor terlalu pendek' },
  { raw: '0812345', national: '812345', valid: false, what: 'HP terlalu pendek' },
  { raw: '09123456789', national: '9123456789', valid: false, what: 'awalan 9 bukan nomor Indonesia' },
];

console.log('\n── Aturan nomor di kedua form vs server ──');
const forms = {
  'SPK (apps/web/app/page.tsx)': formRule('apps/web/app/page.tsx'),
  'Cek n Go (apps/web/app/checkgo/page.tsx)': formRule('apps/web/app/checkgo/page.tsx'),
};
for (const [label, rule] of Object.entries(forms)) {
  for (const c of CASES) {
    ok(rule(c.national) === c.valid, `${label}: ${c.what} (${c.raw}) → ${c.valid ? 'diterima' : 'ditolak'}`);
  }
}

console.log('\n── Server (parseWa) memberi jawaban yang sama ──');
for (const c of CASES) {
  ok(parseWa(c.raw).ok === c.valid, `${c.what} (${c.raw}) → ${c.valid ? 'diterima' : 'ditolak'}`);
}

console.log('\n── Nomor kantor tetap tersimpan sebagai E.164 ──');
ok(parseWa('02155512345').e164 === '+622155512345', '021 5551 2345 → +622155512345');
ok(parseWa('+622155512345').e164 === '+622155512345', 'sudah +62 tetap sama');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
