/**
 * THE NAME ON THE SPK IS NOT THE NAME IN TURBOLY.
 *
 * Live, 2026-08-22: intake wrote "WIDYA", the store's Turboly user list held
 * "WIDYA SARI", the exact-string matcher refused, and the push died with the
 * right person printed in its own list of options. This locks in the widened
 * match — and, far more important, locks in every case where it must still
 * REFUSE, because picking the wrong advisor hands over someone's sales credit.
 *
 *   npx tsx tests/person-match.mts
 */
import { matchPersonLabel, lookupPerson } from '@spk/core';

let passed = 0;
let failed = 0;
const ok = (cond: unknown, msg: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
};

// The exact list Turboly reported for this store in the failed run.
const STORE = [
  'FEBY NUR ISTIQOMAH', 'DINI MARYANTI', 'INDAH AFRIANI',
  'RIANTAMA KENZIRO SIMANJUNTAK', 'WIDYA SARI', 'AYUK NINGTRINAWATI',
  'SUCI LESTARI', 'Dyah Setyarini',
];

console.log('A. the live failure');
const widya = matchPersonLabel(STORE, 'WIDYA');
ok(widya.text === 'WIDYA SARI', `"WIDYA" -> ${widya.text} (dulu gagal push)`);
ok(widya.how === 'starts-with', `cara cocok = ${widya.how}`);
ok(matchPersonLabel(STORE, 'widya  sari').text === 'WIDYA SARI', 'huruf kecil + spasi ganda tetap cocok');
ok(matchPersonLabel(STORE, 'Dyah Setyarini').text === 'Dyah Setyarini', 'nama persis tetap jalan');
ok(matchPersonLabel(STORE, 'DYAH SETYARINI').text === 'Dyah Setyarini', 'beda huruf besar/kecil tetap persis');

console.log('B. the other typing habits');
ok(matchPersonLabel(STORE, 'WIDYA SARI PUTRI').text === 'WIDYA SARI', 'SPK lebih panjang dari daftar Turboly');
ok(matchPersonLabel(STORE, 'SETYARINI').text === 'Dyah Setyarini', 'nama belakang saja, kalau cuma satu orang');
ok(matchPersonLabel(STORE, 'NUR ISTIQOMAH').text === 'FEBY NUR ISTIQOMAH', 'nama tengah+belakang');
ok(matchPersonLabel(STORE, 'Feby, ').text === 'FEBY NUR ISTIQOMAH', 'koma/spasi liar diabaikan');

console.log('C. it must REFUSE rather than guess');
const two = ['WIDYA SARI', 'WIDYA NINGSIH'];
const amb = matchPersonLabel(two, 'WIDYA');
ok(amb.text === null, 'dua orang bernama WIDYA -> tidak memilih siapa pun');
ok(amb.ambiguous.length === 2, `dan melaporkan keduanya: ${amb.ambiguous.join(', ')}`);
// The dangerous fall-through: a stronger rule is ambiguous, a weaker rule
// would single one out. Stopping at the ambiguity is the whole safety story.
const trap = matchPersonLabel(['WIDYA SARI', 'WIDYA NINGSIH', 'SARI WIDYA'], 'WIDYA');
ok(trap.text === null, 'aturan kuat ambigu -> tidak turun ke aturan lemah');
ok(matchPersonLabel(STORE, 'BUDI').text === null, 'orang yang memang tidak ada -> tetap ditolak');
ok(matchPersonLabel(STORE, '').text === null, 'nama kosong -> tidak pernah memilih');
ok(matchPersonLabel(STORE, '   ').text === null, 'spasi saja -> tidak pernah memilih');
ok(matchPersonLabel(STORE, 'S').text === null, 'satu huruf tidak cukup untuk menunjuk orang');
ok(matchPersonLabel(STORE, 'DI').text === null, 'dua huruf tidak cukup');
ok(matchPersonLabel(['SU'], 'SU').text === 'SU', 'tapi nama pendek yang PERSIS tetap boleh');
ok(matchPersonLabel(['ANDI', 'ANDI'], 'ANDI').text === null, 'dua orang bernama sama persis -> tidak menebak');
ok(matchPersonLabel([], 'WIDYA').text === null, 'daftar kosong -> tidak memilih');

console.log('D. the mirror uses the same rule as the dropdown');
// If validation accepts a name the dropdown would refuse, the SPK passes
// review and then dies at push — which is exactly what happened here.
const mk = (name: string) => ({ _id: name, name, mechanicCode: name, storeCode: null, role: 'advisor', syncedAt: '' });
const byName = new Map(STORE.map((n) => [n.toUpperCase().replace(/\s+/g, ' '), mk(n)]));
ok(lookupPerson(byName, 'WIDYA')?.name === 'WIDYA SARI', 'mirror: "WIDYA" -> WIDYA SARI');
ok(lookupPerson(byName, 'BUDI') === null, 'mirror: nama asing tetap ditolak (BLOCK di validasi)');
ok(lookupPerson(new Map(), 'WIDYA') === null, 'mirror kosong -> null, bukan crash');
for (const n of STORE) {
  const hit = lookupPerson(byName, n);
  if (hit?.name !== n) ok(false, `mirror: nama lengkap "${n}" harus cocok dengan dirinya sendiri`);
}
ok(true, 'mirror: ke-8 nama lengkap cocok dengan dirinya sendiri');

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
