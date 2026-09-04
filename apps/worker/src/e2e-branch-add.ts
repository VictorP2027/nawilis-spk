import { connect, close, collections, getDb, loadBranchList, REF_BRANCHES } from '@spk/core';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * ACCEPTANCE RUN for "open a branch without a deploy".
 *
 * The --dry-run rehearsal proves everything UP TO the writes. Nothing proved
 * the writes themselves, and they are the part with no undo: a branch code is
 * permanent, there is no delete, and a wrong store mapping quietly files one
 * branch's orders under another. So this drives the REAL branch-add.ts as a
 * subprocess — the same entrypoint the workflow runs, not a copy of it — and
 * then reads the database back, because what the next SPK sees is the only
 * thing this feature is judged on.
 *
 * It checks the promises the docstring makes, in the order they matter:
 *
 *   1. --dry-run writes NOTHING (checked against a real database, not a log)
 *   2. a real run fills all three: picker row, store mapping, advisors
 *   3. the picker offers it, at the END, with the 27 built-ins in place
 *   4. re-running is safe — no duplicates
 *   5. a RENAME lands (a rebranded outlet)
 *   6. an existing store mapping is NEVER re-pointed
 *   7. the refusals hold: built-in code, malformed code, unknown store
 *
 * ONE HARD GUARD: it refuses to run against the production database. That is
 * the only guard needed — branch-add only ever READS Turboly (it opens the
 * order form to read the store dropdown and that store's people), so pointing
 * MONGODB_DB at a scratch database makes the run faithful and inert.
 *
 *   MONGODB_DB=spk_e2e_branch node --import tsx apps/worker/src/e2e-branch-add.ts
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const CODE = (arg('code') ?? 'NWL-E2E').toUpperCase();
const STORE = arg('store') ?? 'Nawilis Bekasi';
const NAME = arg('name') ?? 'Cabang Uji Otomatis';

const log = (m: string): void => console.log(`[e2e-branch ${CODE}] ${m}`);
let passed = 0;
const fail = (m: string): never => {
  console.error(`\n✗ GAGAL: ${m}\n`);
  process.exit(1);
};
const ok = (cond: boolean, label: string): void => {
  if (!cond) fail(label);
  passed++;
  console.log(`      ✓ ${label}`);
};

/** Run the real entrypoint exactly as the workflow does, and hand back its output. */
function runBranchAdd(args: string[]): Promise<{ code: number; out: string }> {
  const script = new URL('./branch-add.ts', import.meta.url).pathname;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      env: { ...process.env, MONGODB_DB: config.mongoDb },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const counts = async (): Promise<{ branches: number; stores: number; people: number }> => ({
  branches: await collections.branches().countDocuments({ _id: CODE } as never),
  stores: await collections.tbStores().countDocuments({ _id: CODE } as never),
  people: await collections.tbMechanics().countDocuments({ storeCode: CODE } as never),
});

async function main(): Promise<void> {
  if (config.mongoDb === 'spk') fail('pakai database terpisah (MONGODB_DB=spk_e2e_branch), jangan database produksi');
  if (REF_BRANCHES.some((b) => b.code === CODE)) fail(`${CODE} adalah cabang bawaan — pakai kode uji yang lain`);
  await connect(config.mongoUri, config.mongoDb);
  log(`base=${config.turbolyBaseUrl} db=${config.mongoDb} store="${STORE}"`);

  try {
    // A scratch database that carried rows from a previous run would let a
    // no-op pass as a success.
    await getDb().dropDatabase();
    const start = await counts();
    ok(start.branches === 0 && start.stores === 0 && start.people === 0, 'database uji kosong sebelum mulai');

    // 1. The rehearsal. This is the claim the whole page rests on.
    log('1/7 uji coba (--dry-run) — harus tidak menulis apa pun');
    const dry = await runBranchAdd([`--code=${CODE}`, `--name=${NAME}`, `--store=${STORE}`, '--dry-run']);
    ok(dry.code === 0, 'uji coba selesai tanpa error');
    ok(/TIDAK ADA yang ditulis/.test(dry.out), 'uji coba melaporkan tidak menulis apa pun');
    ok(/akan dipetakan ke store Turboly/.test(dry.out), 'uji coba benar-benar membaca store dari Turboly');
    const afterDry = await counts();
    ok(afterDry.branches === 0, 'setelah uji coba: TIDAK ada baris picker');
    ok(afterDry.stores === 0, 'setelah uji coba: TIDAK ada pemetaan store');
    ok(afterDry.people === 0, 'setelah uji coba: TIDAK ada advisor tersalin');

    // 2. The real thing.
    log('2/7 jalan beneran — harus mengisi ketiganya');
    const real = await runBranchAdd([`--code=${CODE}`, `--name=${NAME}`, `--store=${STORE}`, '--abbrev=E2E']);
    ok(real.code === 0, 'jalan beneran selesai tanpa error');
    const row = await collections.branches().findOne({ _id: CODE } as never) as { name: string; type: string; docAbbrev: string } | null;
    ok(row?.name === NAME, `baris picker tertulis dengan nama "${NAME}"`);
    ok(row?.type === 'NAWILIS', 'tipe cabang tersimpan');
    ok(row?.docAbbrev === 'E2E', 'singkatan dokumen tersimpan');
    const store = await collections.tbStores().findOne({ _id: CODE } as never) as { turbolyStoreId: string; turbolyStoreName: string } | null;
    ok(!!store, 'pemetaan store tertulis');
    ok(/^\d+$/.test(store?.turbolyStoreId ?? ''), `store id dari Turboly, bukan tebakan (id ${store?.turbolyStoreId})`);
    const advisors = await collections.tbMechanics().countDocuments({ storeCode: CODE, role: 'advisor' } as never);
    const people = await collections.tbMechanics().countDocuments({ storeCode: CODE } as never);
    ok(advisors > 0, `advisor tersalin (${advisors}) — tanpa ini SPK pertama ditolak saat push`);
    ok(people > advisors, `salesperson ikut tersalin (${people - advisors})`);

    // 3. What the counter actually sees.
    log('3/7 picker');
    const list = await loadBranchList();
    ok(list.some((b) => b.code === CODE), 'cabang baru muncul di picker');
    ok(list[list.length - 1]?.code === CODE, 'muncul di AKHIR — urutan yang dihafal kasir tidak berubah');
    ok(list.slice(0, REF_BRANCHES.length).every((b, i) => b.code === REF_BRANCHES[i]!.code), `${REF_BRANCHES.length} cabang bawaan tetap di urutan semula`);

    // 4. Re-running must not duplicate. Every push is filed under the code.
    log('4/7 jalan ulang — harus aman');
    const again = await runBranchAdd([`--code=${CODE}`, `--name=${NAME}`, `--store=${STORE}`, '--abbrev=E2E']);
    ok(again.code === 0, 'jalan ulang selesai tanpa error');
    const c2 = await counts();
    ok(c2.branches === 1, 'tetap SATU baris picker');
    ok(c2.stores === 1, 'tetap SATU pemetaan store');
    ok(c2.people === people, `jumlah orang tidak bertambah (${c2.people})`);

    // 5. A rename is the point of the row being in Mongo.
    log('5/7 ganti nama');
    const renamed = await runBranchAdd([`--code=${CODE}`, '--name=Cabang Uji (ganti nama)', `--store=${STORE}`]);
    ok(renamed.code === 0, 'ganti nama selesai tanpa error');
    const rr = await collections.branches().findOne({ _id: CODE } as never) as { name: string } | null;
    ok(rr?.name === 'Cabang Uji (ganti nama)', 'nama cabang berubah tanpa deploy');
    ok((await counts()).branches === 1, 'dan tidak menggandakan dirinya');

    // 6. The refusal that protects live orders, plus the store list we need next.
    log('6/7 penolakan');
    const bogus = await runBranchAdd([`--code=${CODE}-X`, '--name=Toko Karangan', '--store=Toko Yang Tidak Ada']);
    ok(bogus.code !== 0, 'store yang tidak ada di Turboly ditolak');
    ok(await collections.branches().countDocuments({ _id: `${CODE}-X` } as never) === 0, 'dan tidak meninggalkan baris picker');

    const listed = bogus.out.match(/Pilihan: (.+)/)?.[1]?.split(', ').map((s) => s.trim()) ?? [];
    const other = listed.find((s) => s && s.toUpperCase() !== STORE.toUpperCase());
    if (other) {
      const repoint = await runBranchAdd([`--code=${CODE}`, `--name=${NAME}`, `--store=${other}`]);
      ok(repoint.code === 0, `jalan ulang dengan store lain ("${other}") selesai tanpa error`);
      const s2 = await collections.tbStores().findOne({ _id: CODE } as never) as { turbolyStoreId: string; turbolyStoreName: string } | null;
      ok(s2?.turbolyStoreId === store?.turbolyStoreId, 'pemetaan store TIDAK dipindah — order cabang ini tidak bisa salah masuk');
      ok(/tidak dipindah/.test(repoint.out), 'dan mengatakannya terang-terangan');
    } else {
      log('   (daftar store tidak terbaca — uji "tidak dipindah" dilewati)');
    }

    const builtIn = REF_BRANCHES[0]!;
    const clash = await runBranchAdd([`--code=${builtIn.code}`, '--name=Bajakan', `--store=${STORE}`]);
    ok(clash.code !== 0, `kode cabang bawaan (${builtIn.code}) ditolak`);
    const bad = await runBranchAdd(['--code=nwl jkt!', '--name=Kode Aneh', `--store=${STORE}`]);
    ok(bad.code !== 0, 'kode cabang yang tidak wajar ditolak');
    ok(!/Cannot navigate/.test(bad.out), 'penolakan terjadi sebelum Turboly dibuka');

    // 7. Leave nothing behind.
    log('7/7 bersih-bersih');
    await getDb().dropDatabase();
    ok((await counts()).branches === 0, 'database uji dihapus lagi');

    console.log(`\n✓ LULUS — ${passed} pemeriksaan. Jalur tulis terbukti, database produksi tidak disentuh.`);
  } finally {
    await close().catch(() => {});
  }
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));
