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
import { MongoMemoryServer } from 'mongodb-memory-server';
import { readFile, readdir } from 'node:fs/promises';
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

console.log('E. a branch added with NO deploy');
// The whole point: a row in Mongo has to reach the picker exactly like a
// compiled-in branch, or "add without pushing code" is not true.
const mongod = await MongoMemoryServer.create();
const { connect, close, collections, loadBranchList } = await import('@spk/core');
await connect(mongod.getUri(), 'spk_branch_test');
try {
  const before = await loadBranchList();
  ok(before.length === REF_BRANCHES.length, `tanpa baris tambahan: ${before.length} cabang bawaan`);

  await collections.branches().insertOne({
    _id: 'NWL-ZZZ', name: 'Cabang Uji', type: 'NAWILIS', docAbbrev: 'ZZZ',
    turbolyStoreNameGuess: 'Nawilis Cabang Uji', addedAt: new Date().toISOString(), addedBy: 'tes',
  } as never);
  const after = await loadBranchList();
  ok(after.length === REF_BRANCHES.length + 1, 'cabang baru muncul di daftar tanpa deploy');
  ok(after[after.length - 1]!.code === 'NWL-ZZZ', 'ditambahkan di akhir — urutan yang dihafal kasir tidak berubah');
  ok(after.slice(0, REF_BRANCHES.length).every((b, i) => b.code === REF_BRANCHES[i]!.code), 'ke-27 cabang bawaan tetap di urutan semula');
  ok(branchForNewStore('Nawilis Cabang Uji', new Set(), after)?.code === 'NWL-ZZZ', 'sync bisa memetakan store-nya nanti');

  // A rename must work (a rebranded outlet) but a code must never be reassigned.
  await collections.branches().insertOne({
    _id: 'NWL-BKS', name: 'Bekasi (pindah)', type: 'NAWILIS', docAbbrev: 'BKS',
    turbolyStoreNameGuess: 'Nawilis Bekasi', addedAt: new Date().toISOString(), addedBy: 'tes',
  } as never);
  const renamed = await loadBranchList();
  ok(renamed.find((b) => b.code === 'NWL-BKS')?.name === 'Bekasi (pindah)', 'cabang bawaan boleh diganti NAMANYA tanpa deploy');
  ok(renamed.length === REF_BRANCHES.length + 1, 'dan tidak menggandakan dirinya');
  ok(renamed.filter((b) => b.code === 'NWL-BKS').length === 1, 'satu kode tetap satu cabang');

  // The workflow env block. A `${{ secrets.X }}` for an X that was never created
  // does not fail the run — it expands to '', slips past config.ts's `??` (an
  // empty string is not nullish) and dies 130 lines later inside page.goto as
  // "Cannot navigate to invalid URL". Every other live workflow hardcodes these
  // two, so branch-add.yml must too.
  const wfDir = new URL('../.github/workflows/', import.meta.url);
  const wfNames = (await readdir(wfDir)).filter((f) => f.endsWith('.yml'));
  ok(wfNames.length >= 8, `ketemu ${wfNames.length} workflow untuk diperiksa`);

  for (const f of wfNames) {
    const yml = await readFile(new URL(f, wfDir), 'utf8');
    for (const key of ['TURBOLY_BASE_URL', 'MONGODB_DB'] as const) {
      for (const line of yml.split('\n')) {
        const m = line.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`));
        if (!m) continue;
        const value = m[1]!;
        ok(!value.includes('secrets.'), `${f}: ${key} tidak dibaca dari secret (${value})`);
        if (key === 'TURBOLY_BASE_URL') {
          ok(/^https:\/\/\S+$/.test(value), `${f}: ${key} berupa URL utuh (${value})`);
        } else {
          ok(/^\S+$/.test(value), `${f}: ${key} terisi (${value})`);
        }
      }
    }
  }

  // And the guard that turns a bad value into a sentence a human can act on.
  const src = await readFile(new URL('../apps/worker/src/branch-add.ts', import.meta.url), 'utf8');
  const guardAt = src.indexOf('TURBOLY_BASE_URL tidak sah');
  ok(guardAt > 0, 'branch-add.ts menolak base URL yang tidak sah dengan pesan yang jelas');
  ok(guardAt < src.indexOf('/service_orders/new'), 'dan menolaknya SEBELUM membuka halaman Turboly');

} finally {
  await close().catch(() => {});
  await mongod.stop();
}

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
