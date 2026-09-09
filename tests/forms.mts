/**
 * THE TWO FORMS MUST AGREE WITH EACH OTHER, AND WITH THE SERVER.
 *
 * A landline fix went into the server and into the SPK form, and the Cek n Go
 * form kept its own mobile-only copy of the rule — so the same office number
 * was accepted on one form and refused on the other, and only a person at a
 * counter could discover it.
 *
 * This reads the RULE OUT OF BOTH FORMS and runs it against the same numbers as
 * the server's parseWa. It fails the moment one of them drifts again.
 *
 *   npx tsx tests/forms.mts
 */
import { readFileSync } from 'node:fs';
import { parseWa, parsePlate, formPhone, isForeignPhone, localPhone } from '@spk/core';

let passed = 0;
let failed = 0;
const ok = (cond: unknown, msg: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
};

/**
 * Pull the whole phone rule out of a form — `waDigits`, `waForeign`, `waNat`,
 * `waOk` and the `waE164Preview` the counter is shown — and turn it into a
 * function of the typed string. Lifting only `waOk` was not enough: the
 * foreign-number bug lived in how `waNat` was derived and in the preview,
 * and `waOk` alone said "accepted" for "+65 8305 0688" while the tick promised
 * "+626583050688".
 */
function formRule(file: string): (wa: string) => { ok: boolean; preview: string | null } {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const lift = (name: string): string => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
    if (!m) throw new Error(`tidak menemukan aturan ${name} di ${file}`);
    return m[1]!;
  };
  const body = [
    `const waDigits = ${lift('waDigits')};`,
    `const waForeign = ${lift('waForeign')};`,
    `const waNat = ${lift('waNat')};`,
    `const waOk = ${lift('waOk')};`,
    `const waE164Preview = ${lift('waE164Preview')};`,
    'return { ok: waOk, preview: waE164Preview };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('wa', body) as (wa: string) => { ok: boolean; preview: string | null };
}

/** `e164` is what the SERVER stores; a form that accepts the number must promise the same spelling. */
const CASES: Array<{ raw: string; valid: boolean; e164?: string; what: string }> = [
  { raw: '08123456789', valid: true, e164: '+628123456789', what: 'HP biasa' },
  { raw: '+628123456789', valid: true, e164: '+628123456789', what: 'HP dengan +62' },
  { raw: '+62 812 3456 789', valid: true, e164: '+628123456789', what: 'HP dengan +62 dan spasi' },
  { raw: '+622155512345', valid: true, e164: '+622155512345', what: 'nomor kantor Jakarta (+6221)' },
  { raw: '02155512345', valid: true, e164: '+622155512345', what: 'nomor kantor ditulis 021' },
  { raw: '0315551234', valid: true, e164: '+62315551234', what: 'nomor kantor Surabaya (031)' },
  { raw: '+622212345', valid: false, what: 'nomor kantor terlalu pendek' },
  { raw: '0812345', valid: false, what: 'HP terlalu pendek' },
  { raw: '09123456789', valid: false, what: 'awalan 9 bukan nomor Indonesia' },
  // Jane, 9 Sep 2026: "+65 … shows up in Turboly as +6265 …". A number typed
  // with its own country code is kept as typed — on the server since 5 Aug,
  // and now on both forms too.
  { raw: '+65 8305 0688', valid: true, e164: '+6583050688', what: 'nomor Singapura dengan +' },
  { raw: '+6583050688', valid: true, e164: '+6583050688', what: 'nomor Singapura tanpa spasi' },
  { raw: '+1 415 555 2671', valid: true, e164: '+14155552671', what: 'nomor Amerika dengan +' },
  { raw: '+60 12 345 6789', valid: true, e164: '+60123456789', what: 'nomor Malaysia dengan +' },
  { raw: '+65 1234', valid: false, what: 'nomor luar negeri terlalu pendek' },
  { raw: '+0812 3456 789', valid: false, what: '"+0" bukan kode negara' },
  { raw: '+65 8305 0688 1234 567', valid: false, what: 'lebih dari 15 digit bukan nomor telepon' },
  // WITHOUT the "+" the digits are an Indonesian number, exactly as before:
  // 065 is an Aceh area code. This is the trap — the "+" is what says "abroad".
  { raw: '6583050688', valid: true, e164: '+626583050688', what: 'tanpa + tetap dibaca nomor Indonesia (kode area 065)' },
];

console.log('\n── Aturan nomor di kedua form vs server ──');
const forms = {
  'SPK (apps/web/app/page.tsx)': formRule('apps/web/app/page.tsx'),
  'Cek n Go (apps/web/app/checkgo/page.tsx)': formRule('apps/web/app/checkgo/page.tsx'),
};
for (const [label, rule] of Object.entries(forms)) {
  for (const c of CASES) {
    const r = rule(c.raw);
    ok(r.ok === c.valid, `${label}: ${c.what} (${c.raw}) → ${c.valid ? 'diterima' : 'ditolak'}`);
    if (c.valid) ok(r.preview === c.e164, `${label}: ${c.what} — centang menjanjikan ${c.e164}, form bilang ${r.preview}`);
  }
}

console.log('\n── Server (parseWa) memberi jawaban yang sama ──');
for (const c of CASES) {
  const p = parseWa(c.raw);
  ok(p.ok === c.valid, `${c.what} (${c.raw}) → ${c.valid ? 'diterima' : 'ditolak'}`);
  if (c.valid) ok(p.e164 === c.e164, `${c.what} — disimpan sebagai ${c.e164} (server: ${p.e164})`);
}

console.log('\n── Nomor yang tersimpan kembali ke form tanpa berubah arti ──');
for (const c of CASES) {
  if (!c.valid || !c.e164) continue;
  const back = formPhone(c.e164);
  const again = parseWa(back).e164;
  ok(again === c.e164, `${c.what}: ${c.e164} → form "${back}" → ${again}`);
  ok(isForeignPhone(c.e164) === !c.e164.startsWith('+62'), `${c.what}: isForeignPhone(${c.e164}) = ${isForeignPhone(c.e164)}`);
}
ok(formPhone('+628123456789') === '08123456789', 'nomor Indonesia tetap tampil 08… di form (seperti sebelumnya)');
ok(formPhone('+622155512345') === '02155512345', 'nomor kantor tetap tampil 021… di form (seperti sebelumnya)');
ok(formPhone('+6583050688') === '+6583050688', 'nomor luar negeri tampil apa adanya, bukan 0658…');
ok(localPhone('+6583050688') === '06583050688', 'localPhone sendiri tidak berubah (masih dipakai pencarian ejaan lama)');
ok(formPhone('+626583050688') === '06583050688', 'record yang terlanjur +6265… tetap konsisten sebagai nomor Indonesia');

console.log('\n── Nomor kantor tetap tersimpan sebagai E.164 ──');
ok(parseWa('02155512345').e164 === '+622155512345', '021 5551 2345 → +622155512345');
ok(parseWa('+622155512345').e164 === '+622155512345', 'sudah +62 tetap sama');

/**
 * Every rule the two forms SHARE must be written identically.
 *
 * The office-number bug was exactly this: both forms had their own copy of the
 * phone rule and only one was fixed. Anything genuinely one-sided (an SPK's job
 * lines, a Cek n Go's checklist) simply is not in both files, so it never
 * reaches this comparison.
 */
function ruleTable(file: string): Map<string, string> {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/const (\w+Ok)\s*=\s*([^;]+);/g)) {
    out.set(m[1]!, (m[2] ?? '').split(/\s+/).join(' ').trim());
  }
  return out;
}

/**
 * Same meaning, different spelling — a check on the typed string vs the parsed
 * number. Listed here so the comparison stays strict about everything else.
 */
const KNOWN_DIFFERENT = new Set(['estimasiOk']);

console.log('\n── Aturan yang ada di KEDUA form harus persis sama ──');
{
  const spk = ruleTable('apps/web/app/page.tsx');
  const cng = ruleTable('apps/web/app/checkgo/page.tsx');
  const shared = [...spk.keys()].filter((k) => cng.has(k)).sort();
  ok(shared.length >= 8, `ada ${shared.length} aturan yang dipakai kedua form`);
  for (const k of shared) {
    if (KNOWN_DIFFERENT.has(k)) continue;
    ok(spk.get(k) === cng.get(k), `${k} sama di SPK dan Cek n Go`);
  }
  console.log(`     (hanya di SPK: ${[...spk.keys()].filter((k) => !cng.has(k)).join(', ') || '-'})`);
  console.log(`     (hanya di Cek n Go: ${[...cng.keys()].filter((k) => !spk.has(k)).join(', ') || '-'})`);
}

console.log('\n── Plat: apa pun boleh masuk, yang aneh cuma diperingatkan ──');
{
  // A red official/service plate. It has no area letter, so every civilian
  // reading has to invent one — and the corrector used to do exactly that.
  const dinas = parsePlate('43562-00');
  ok(dinas.display === '43562-00', `ditulis apa adanya: ${dinas.display}`);
  ok(dinas.full === '4356200', 'kuncinya angka saja, jadi 43562-00 dan 43562 00 satu mobil');
  ok(dinas.correctionsApplied.length === 0, 'tidak ada huruf yang dikarang');
  ok(dinas.ok === false, 'ditandai tidak baku → peringatan, bukan penolakan');

  const flipped = parsePlate('00-43562');
  ok(!/[A-Z]/.test(flipped.full), `ditulis terbalik pun tetap angka (dulu jadi O0435GZ): ${flipped.full}`);
  ok(flipped.display === '00-43562', 'dan tampilannya utuh');

  // Civilian plates must be untouched by all of this.
  const civil = parsePlate('B 1234 SZA');
  ok(civil.ok && civil.full === 'B1234SZA' && civil.area === 'B', 'plat biasa tidak berubah');
  const spaced = parsePlate('b1234sza');
  ok(spaced.full === 'B1234SZA', 'huruf kecil tetap sama mobilnya');
}

console.log(`\n${passed} passed, ${failed} failed`);

console.log('H. carwash-only: a job picked in "Pekerjaan lain" counts');
// Jane, live: a customer who only comes for a carwash had no tile to tap and
// the form refused to submit at all. A picked SKU is what becomes a real
// service line, so it is what may satisfy the minimum — prose still cannot.
{
  const files = ['apps/web/app/page.tsx', 'apps/web/app/sheet/page.tsx'];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const m = /const jobFromText = \(t: string\): boolean =>\s*([^;]+);/.exec(src);
    ok(Boolean(m), `${f}: aturan jobFromText ada`);
    if (!m) continue;
    // eslint-disable-next-line no-new-func
    const fn = new Function('t', `return ${m[1]};`) as (t: string) => boolean;
    ok(fn('CWS-NAW-CWS1 Carwash'), `${f}: "CWS-NAW-CWS1 Carwash" dihitung pekerjaan`);
    ok(fn('TPI-NAWJAS-PM Periodic Maintenance'), `${f}: Periodic Maintenance juga`);
    ok(!fn('cuci mobil'), `${f}: tulisan bebas TANPA SKU tidak dihitung (Turboly menolak)`);
    ok(!fn(''), `${f}: kosong tidak dihitung`);
    ok(!fn('CWS 123'), `${f}: bukan bentuk SKU tidak dihitung`);
  }
}


// ── Duplicate-customer guard on the SPK form ──────────────────────────────
// A plate Turboly does not hold forces the push to identify the customer from
// the typed name instead, which for a COMPANY regularly creates a second
// record that can never be merged back. The form warns while the car is still
// at the counter. Driven from the REAL expressions, not a copy of them.
{
  const src = readFileSync(new URL('../apps/web/app/page.tsx', import.meta.url), 'utf8');
  const grab = (name: string): string => {
    const m = new RegExp(`const ${name} =([^;]+);`, 's').exec(src);
    if (!m) throw new Error(`aturan ${name} tidak ditemukan di page.tsx`);
    return m[1]!;
  };
  // eslint-disable-next-line no-new-func
  const notOnRecord = new Function('custSource', 'custHint', 'plateNorm', 'custPlates',
    `return (${grab('plateNotOnRecord')});`) as (a: string | null, b: string | null, c: string, d: Set<string>) => boolean;
  // eslint-disable-next-line no-new-func
  const corporate = new Function('regName', 'nama',
    `return (${grab('looksCorporate')});`) as (a: string | null, b: string) => boolean;

  const SUMI = new Set(['A29SJP', 'B63YNA']);
  ok(notOnRecord('turboly', 'SUMI — 2 kendaraan', 'B1234XY', SUMI), 'plat asing pada customer yang dikenal → diperingatkan');
  ok(!notOnRecord('turboly', 'SUMI — 2 kendaraan', 'A29SJP', SUMI), 'plat yang memang miliknya → tidak diganggu');
  // The Mongo fallback knows our history, not the ERP's vehicle list. Warning
  // from it would be a guess, and a guess that blocks the counter.
  ok(!notOnRecord('mongo', 'SUMI — 2 kendaraan', 'B1234XY', SUMI), 'jawaban dari Mongo tidak pernah memicu peringatan');
  ok(!notOnRecord(null, null, 'B1234XY', new Set()), 'customer tidak dikenal → tidak ada peringatan');
  ok(!notOnRecord('turboly', 'SUMI — 2 kendaraan', 'B12', SUMI), 'plat setengah diketik belum dinilai');

  ok(corporate('PT. ANGKASA PURA LOGISTIK', ''), 'PT dikenali sebagai perusahaan');
  ok(corporate(null, 'CV SINAR JAYA'), 'CV juga');
  ok(corporate('KOPERASI KARYAWAN', ''), 'koperasi juga');
  ok(!corporate('SUMI', 'SUMI'), 'orang biasa bukan perusahaan');
  // The trap: a person whose name merely CONTAINS those letters.
  ok(!corporate('SEPTIAN', 'SEPTIAN'), '"SEPTIAN" tidak dikira PT');
  ok(!corporate('CVETKOVIC', 'CVETKOVIC'), '"CVETKOVIC" tidak dikira CV');
  ok(!corporate('UDIN', 'UDIN'), '"UDIN" tidak dikira UD');
}

// ── VIN on an electric vehicle: optional, but a typed one must look like one ──
// Driven from the REAL expression in page.tsx, so it cannot drift.
{
  const src = readFileSync(new URL('../apps/web/app/page.tsx', import.meta.url), 'utf8');
  const m = /const vinOk = ([^;]+);/.exec(src);
  if (!m) throw new Error('aturan vinOk tidak ditemukan di page.tsx');
  // eslint-disable-next-line no-new-func
  const vinOk = new Function('fuelMode', 'vin', `return (${m[1]});`) as (f: string, v: string) => boolean;
  ok(vinOk('ev', ''), 'mobil listrik tanpa VIN → boleh kirim (opsional)');
  ok(vinOk('ev', '   '), 'spasi saja dihitung kosong');
  ok(vinOk('ev', 'MHKA6GJ6JLK012345'), 'VIN lengkap tetap diterima');
  ok(!vinOk('ev', 'ABC'), 'VIN yang diketik tapi terlalu pendek tetap ditolak — bentuknya masih diperiksa');
  ok(vinOk('fuel', ''), 'mobil BBM tidak pernah ditanya');
  ok(vinOk('fuel', 'AB'), 'mobil BBM tidak memeriksa VIN');
}

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
