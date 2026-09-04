/**
 * OPENING A BRANCH SHOULD BE ONE EDIT.
 *
 * It used to be four, in three systems: the picker's list, core's list, the
 * tb_stores row (which needs Turboly's internal store id) and that branch's
 * advisors. Two of those were copies of each other and had to be kept in step
 * by hand; the other two needed someone who knew where to look.
 *
 * Now: add the branch to REF_BRANCHES. The picker reads that same list, and
 * the next catalogue sync maps the store Turboly reports and harvests its
 * advisors. This locks both halves — above all, the refusals, because a wrong
 * store mapping quietly files one branch's orders under another branch.
 *
 *   npx tsx tests/branch-add.mts
 */
import { REF_BRANCHES, branchForNewStore } from '@spk/core';
import { BRANCHES } from '../apps/web/lib/refdata.client.js';

let passed = 0;
let failed = 0;
const ok = (cond: unknown, msg: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
};
const none = new Set<string>();

console.log('A. one list, not two');
ok(BRANCHES.length === REF_BRANCHES.length, `picker dan core sama panjang (${BRANCHES.length})`);
ok(
  BRANCHES.every((b, i) => b.code === REF_BRANCHES[i]!.code && b.name === REF_BRANCHES[i]!.name && b.type === REF_BRANCHES[i]!.type),
  'kode, nama, dan urutannya identik — picker tidak bisa lagi beda dari pusher',
);

console.log('B. a branch that just opened');
const NEW = { code: 'NWL-XXX', name: 'Cabang Baru', type: 'NAWILIS', docAbbrev: 'XXX', turbolyStoreNameGuess: 'Nawilis Cabang Baru' } as const;
const list = [...REF_BRANCHES, NEW];
ok(branchForNewStore('Nawilis Cabang Baru', none, list)?.code === 'NWL-XXX', 'nama persis -> dipetakan');
ok(branchForNewStore('NAWILIS   cabang-baru', none, list)?.code === 'NWL-XXX', 'beda huruf besar/kecil, spasi, tanda baca -> tetap dipetakan');
ok(branchForNewStore('Nawilis Cabang Lama', none, list) === null, 'toko lain -> tidak dipetakan');

console.log('C. it must refuse rather than mis-file an order');
const mapped = new Set(REF_BRANCHES.map((b) => b.code));
ok(branchForNewStore('Nawilis Bekasi', mapped) === null, 'cabang yang SUDAH punya toko -> tidak pernah dipindah');
const twins = [
  { ...NEW, code: 'A-1' },
  { ...NEW, code: 'A-2' },
] as const;
ok(branchForNewStore('Nawilis Cabang Baru', none, twins) === null, 'dua cabang bernama sama -> tidak menebak');
ok(branchForNewStore('', none, list) === null, 'nama toko kosong -> tidak memetakan apa pun');
ok(branchForNewStore('   ', none, list) === null, 'spasi saja -> tidak memetakan apa pun');
ok(branchForNewStore('Nawilis', none, list) === null, 'nama sepotong bukan kecocokan — harus persis');
ok(branchForNewStore('Nawilis Cabang Baru', new Set(['NWL-XXX']), list) === null, 'sudah dipetakan di run sebelumnya -> tidak ditulis ulang');

console.log('D. the 27 branches we already have');
// Each existing branch must still match its own store name and nobody else's:
// if two guesses collided, the sync could map the wrong one the day either
// store is re-created in Turboly.
let selfOk = 0;
for (const b of REF_BRANCHES) {
  const others = new Set(REF_BRANCHES.map((x) => x.code).filter((c) => c !== b.code));
  if (branchForNewStore(b.turbolyStoreNameGuess, others)?.code === b.code) selfOk++;
  else ok(false, `${b.code} tidak cocok dengan namanya sendiri ("${b.turbolyStoreNameGuess}")`);
}
ok(selfOk === REF_BRANCHES.length, `ke-${REF_BRANCHES.length} cabang cocok dengan toko-nya sendiri, tanpa bentrok`);

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
