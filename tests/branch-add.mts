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
import { REF_BRANCHES, branchForNewStore, branchTypeFor, buildSpkDoc } from '@spk/core';
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

  // A branch opened since the deploy is not in REF_BRANCHES, so buildSpkDoc
  // used to fall back to NAWILIS for it — silently mistyping a new QUICKSERV
  // counter and dropping its queue priority from 95 to 50.
  await collections.branches().insertOne({
    _id: 'NWL-QS9', name: 'QuickServ Baru', type: 'QUICKSERV', docAbbrev: 'QS9',
    turbolyStoreNameGuess: 'QuickServ Baru', addedAt: new Date().toISOString(), addedBy: 'tes',
  } as never);
  ok(await branchTypeFor('NWL-QS9') === 'QUICKSERV', 'cabang QUICKSERV baru terbaca QUICKSERV, bukan NAWILIS');
  // Deliberately a QUICKSERV built-in: asserting on a NAWILIS one would pass
  // even with the whole lookup replaced by `return 'NAWILIS'`.
  const builtInQs = REF_BRANCHES.find((b) => b.type === 'QUICKSERV')!;
  ok(await branchTypeFor(builtInQs.code) === 'QUICKSERV', `cabang bawaan QUICKSERV (${builtInQs.code}) tidak tertukar jadi NAWILIS`);
  ok(await branchTypeFor('NWL-TIDAK-ADA') === 'NAWILIS', 'kode tak dikenal tetap jatuh ke NAWILIS');

  // The repo.ts half, exercised rather than grepped: a source regex stays green
  // if the wiring is reverted, so build a real document and read the field the
  // queue priority is computed from.
  const intake = (branchCode: string) => ({
    uploadId: `tes-${branchCode}`, docType: 'SPK_NAWILIS', branchCode, captureMode: 'typed',
    operatorUserId: 'tes', operatorPinVerified: true, deviceBindingVerified: true,
    spkNumber: `TES-${branchCode}`, qrPayload: null, capturedAt: new Date().toISOString(),
    customer: { nama: 'UJI TIPE', wa: '+628123456789', alamat: 'Jl. Uji 1', kontakLain: null, turbolyCustomerId: null },
    vehicle: { noPolisi: 'B1234XYZ', merk: 'Toyota', tipe: 'Avanza', tahun: 2021, warna: 'Silver', km: '31000', kind: 'car', createMakeConfirmed: false },
    complaint: 'cek rutin',
    jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: 350000 }],
    conditionChecks: [], rekomendasiService: null, estimasiMinutes: 60,
    serviceAdvisorName: 'UJI', salespersonName: 'UJI',
    signatures: { menyerahkanPresent: true, menyerahkanInkDensity: 40, menyerahkanNamaJelas: 'UJI', menerimaPresent: true, menerimaNamaJelas: 'UJI' },
    attachments: [],
  });

  const passed = buildSpkDoc(intake('NWL-QS9') as never, { branchType: await branchTypeFor('NWL-QS9') });
  ok(passed.branchType === 'QUICKSERV', 'buildSpkDoc memakai tipe yang diberikan — dokumen cabang baru bertipe QUICKSERV');
  // …and without it, the old bug: the branch is unknown to REF_BRANCHES.
  const unpassed = buildSpkDoc(intake('NWL-QS9') as never);
  ok(unpassed.branchType === 'NAWILIS', 'tanpa diteruskan, tipe jatuh ke NAWILIS — inilah bug yang diperbaiki');
  // A built-in must not regress when nothing is passed.
  const built = buildSpkDoc(intake(builtInQs.code) as never);
  ok(built.branchType === 'QUICKSERV', `cabang bawaan (${builtInQs.code}) tetap QUICKSERV tanpa opsi`);

  // …and the intake path has to actually pass it, or the fix is inert.
  const ingestSrc = await readFile(new URL('../apps/web/lib/ingest.ts', import.meta.url), 'utf8');
  ok(/buildSpkDoc\(input,\s*\{\s*branchType:\s*await branchTypeFor\(/.test(ingestSrc), 'ingestSpk meneruskan tipe cabang ke buildSpkDoc');

  // Every page that renders the branch list must read the MERGED list. The
  // compiled-in BRANCHES is frozen at deploy time, so a page using it alone
  // simply never offers a branch opened through /admin/cabang — which is the
  // whole feature. /checkgo/sheet and /customers were both doing exactly that.
  const appDir = new URL('../apps/web/app/', import.meta.url);
  const pages: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) await walk(child);
      else if (e.name.endsWith('.tsx')) pages.push(child.pathname);
    }
  };
  await walk(appDir);
  ok(pages.length > 5, `${pages.length} halaman diperiksa`);
  let checked = 0;
  for (const f of pages) {
    const src = await readFile(f, 'utf8');
    if (!/\bBRANCHES\b/.test(src)) continue;
    checked++;
    const short = f.slice(f.indexOf('/app/') + 1);
    ok(/useBranches\(\)/.test(src), `${short}: pakai daftar cabang yang digabung (useBranches)`);
  }
  ok(checked >= 7, `${checked} halaman menampilkan daftar cabang`);

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

  // The acceptance run writes for real, so its whole safety story is the two
  // lines below: a scratch database name in the workflow, and a script that
  // refuses production even if someone edits that name.
  const e2eYml = await readFile(new URL('e2e-branch-add.yml', wfDir), 'utf8');
  const e2eDb = e2eYml.match(/^\s*MONGODB_DB:\s*(\S+)/m)?.[1];
  ok(e2eDb !== undefined && e2eDb !== 'spk', `e2e-branch-add.yml pakai database bukan produksi (${e2eDb})`);
  const e2eSrc = await readFile(new URL('../apps/worker/src/e2e-branch-add.ts', import.meta.url), 'utf8');
  ok(/config\.mongoDb === 'spk'/.test(e2eSrc), 'e2e-branch-add.ts menolak database produksi');
  ok(e2eSrc.indexOf("config.mongoDb === 'spk'") < e2eSrc.indexOf('dropDatabase'), 'dan menolaknya SEBELUM menghapus database apa pun');

  // Write ORDER, locked offline. The picker row must not be written until the
  // Turboly store has resolved: a branch code cannot be deleted, so a typo in
  // the store name must fail with nothing left behind.
  const baSrc = await readFile(new URL('../apps/worker/src/branch-add.ts', import.meta.url), 'utf8');
  const storeResolved = baSrc.indexOf('const store = hits[0]!');
  const noStore = baSrc.indexOf('tidak ada di daftar Turboly');
  const pickerCall = baSrc.indexOf('await addToPicker(); // the store is real');
  ok(storeResolved > 0 && noStore > 0 && pickerCall > 0, 'branch-add.ts menulis picker lewat addToPicker()');
  ok(pickerCall > storeResolved, 'baris picker ditulis SETELAH store Turboly ketemu');
  ok(pickerCall > noStore, 'dan setelah titik di mana store yang salah ditolak');

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
