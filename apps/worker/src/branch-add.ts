import { connect, close, collections, REF_BRANCHES } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * OPEN A BRANCH WITHOUT A DEPLOY.
 *
 *   --code=NWL-XXX --name="Cabang Baru" --store="Nawilis Cabang Baru"
 *   [--type=NAWILIS|QUICKSERV|COMPANY] [--abbrev=XXX] [--no-turboly]
 *
 * Three things have to be true before a new counter's first SPK can push, and
 * this does all three:
 *
 *   1. the picker must offer the branch  → the `branches` row, read by
 *      /api/branches on top of the compiled-in list;
 *   2. the branch must map to a Turboly store  → read from Turboly's own store
 *      dropdown by name, because only Turboly knows its internal store id;
 *   3. the branch must have advisors  → harvested from the same form, since an
 *      SPK with an unknown advisor is refused at push.
 *
 * Safe to re-run, but NOT inert: a second run with different text overwrites
 * the row's name, type and docAbbrev (that is what makes a rename possible).
 * What it never edits is the CODE or an existing store mapping — a code is
 * what every SPK ever pushed is filed under, and re-pointing a live branch at
 * another store would quietly misfile its orders. Fixing one of those is a
 * deliberate, separate act.
 *
 * Because a rename IS possible here, the caller is the guard against an
 * accidental one: /api/admin/branch-add refuses a branch that is already
 * complete, and refuses outright when it cannot check.
 *
 * --dry-run does everything EXCEPT write: it validates, logs in, reads
 * Turboly's store dropdown, matches the store and reads that store's advisors,
 * then prints what it WOULD have written. It exists because a branch code is
 * permanent and there is no delete — so the only other way to find out whether
 * this works is to leave a junk branch in every counter's picker forever.
 *
 * --no-turboly writes only the picker row (steps 2 and 3 skipped), for the case
 * where the store does not exist in Turboly yet. The branch is then selectable
 * but its SPKs will hold at "belum terpetakan ke Store Turboly" until this is
 * run again — which is the honest state, and visible on the board.
 */
const arg = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit?.slice(k.length + 3);
};
const has = (k: string): boolean => process.argv.includes(`--${k}`);
const norm = (s: string): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

async function main(): Promise<void> {
  const code = (arg('code') ?? '').trim().toUpperCase();
  const name = (arg('name') ?? '').trim();
  const storeName = (arg('store') ?? '').trim();
  const type = (arg('type') ?? 'NAWILIS').trim().toUpperCase() as 'NAWILIS' | 'QUICKSERV' | 'COMPANY';
  const abbrev = (arg('abbrev') ?? '').trim().toUpperCase() || null;
  const skipTurboly = has('no-turboly');
  const dryRun = has('dry-run');

  if (!code || !name) {
    console.error('butuh --code=NWL-XXX --name="Cabang Baru" [--store="Nama Store di Turboly"]');
    process.exitCode = 1;
    return;
  }
  if (!/^[A-Z0-9-]{3,12}$/.test(code)) {
    console.error(`kode cabang "${code}" tidak wajar — huruf besar, angka dan tanda hubung saja (mis. NWL-XXX)`);
    process.exitCode = 1;
    return;
  }
  if (!['NAWILIS', 'QUICKSERV', 'COMPANY'].includes(type)) {
    console.error(`--type harus NAWILIS, QUICKSERV atau COMPANY (dapat "${type}")`);
    process.exitCode = 1;
    return;
  }
  if (!skipTurboly && !storeName) {
    console.error('butuh --store="Nama Store persis seperti di Turboly", atau --no-turboly untuk menunda');
    process.exitCode = 1;
    return;
  }

  await connect(config.mongoUri, config.mongoDb);
  try {
    // A code that already exists is never silently overwritten: it is either
    // one of the 27 shipped branches or one somebody added, and in both cases
    // re-defining it from a command line is how a live branch gets misfiled.
    const builtIn = REF_BRANCHES.find((b) => b.code === code);
    if (builtIn) {
      console.error(`✗ ${code} sudah ada di daftar bawaan (${builtIn.name}) — tidak diubah dari sini`);
      process.exitCode = 1;
      return;
    }
    const existing = await collections.branches().findOne({ _id: code });
    const existingStore = await collections.tbStores().findOne({ _id: code });
    if (existing) console.log(`· ${code} sudah terdaftar sebagai "${existing.name}" — data picker diperbarui`);

    if (dryRun) {
      console.log(`\n— UJI COBA (--dry-run): tidak ada yang ditulis —`);
      console.log(`  akan ditambahkan ke picker: ${code} "${name}" (${type}${abbrev ? `, singkatan ${abbrev}` : ''})`);
    }
    if (!dryRun) await collections.branches().updateOne(
      { _id: code },
      {
        $set: { _id: code, name, type, docAbbrev: abbrev, turbolyStoreNameGuess: storeName || name },
        $setOnInsert: { addedAt: new Date().toISOString(), addedBy: process.env.GITHUB_ACTOR ?? null },
      },
      { upsert: true },
    );
    if (!dryRun) console.log(`✓ cabang "${name}" (${code}) masuk daftar picker — muncul di form tanpa deploy`);

    if (skipTurboly) {
      console.log('· dilewati: pemetaan store Turboly + advisor (--no-turboly). SPK cabang ini akan tertahan sampai dijalankan lagi tanpa flag itu.');
      return;
    }
    if (existingStore) {
      console.log(`· ${code} sudah dipetakan ke store Turboly "${existingStore.turbolyStoreName}" (id ${existingStore.turbolyStoreId}) — tidak dipindah`);
      return;
    }

    // Only Turboly knows its own store id, so read it from the form staff use.
    const session = new TurbolySession({
      baseUrl: config.turbolyBaseUrl,
      stateDir: './.turboly-state',
      userAgentSuffix: 'branch-add',
      branchCode: code,
    });
    await session.start();
    await session.ensureLoggedIn();
    const page = session.page_();
    const read = (sel: string): Promise<Array<{ v: string; t: string }>> =>
      page.$$eval(`${sel} option`, (els) =>
        els.map((e) => ({ v: (e as HTMLOptionElement).value, t: (e.textContent ?? '').trim() })).filter((o) => o.v && o.t),
      );
    try {
      await page.goto(`${config.turbolyBaseUrl}/service_orders/new`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const stores = await read('#store-id');
      const hits = stores.filter((s) => norm(s.t) === norm(storeName));
      if (hits.length !== 1) {
        console.error(
          hits.length === 0
            ? `✗ store "${storeName}" tidak ada di daftar Turboly. Pilihan: ${stores.map((s) => s.t).join(', ')}`
            : `✗ "${storeName}" cocok dengan ${hits.length} store Turboly — pakai nama yang persis`,
        );
        process.exitCode = 1;
        return;
      }
      const store = hits[0]!;
      const now = new Date().toISOString();
      if (dryRun) console.log(`  akan dipetakan ke store Turboly "${store.t}" (id ${store.v})`);
      if (!dryRun) await collections.tbStores().updateOne(
        { _id: code },
        { $set: { _id: code, turbolyStoreId: String(store.v), turbolyStoreName: store.t, syncedAt: now } },
        { upsert: true },
      );
      if (!dryRun) console.log(`✓ dipetakan ke store Turboly "${store.t}" (id ${store.v})`);

      // Advisors, from the same form — an SPK whose advisor is unknown is
      // refused at push, so a branch without them is a branch that cannot work.
      await page.selectOption('#store-id', { value: String(store.v) });
      await page.waitForTimeout(2600); // the person lists load by AJAX after the store
      const advisors = await read('#service-advisor-id');
      const sales = await read('#salesperson-id');
      const seen = new Set<string>();
      for (const a of advisors) {
        if (!dryRun) await collections.tbMechanics().updateOne(
          { _id: `${code}:${a.v}` },
          { $set: { _id: `${code}:${a.v}`, mechanicCode: a.v, name: a.t, storeCode: code, role: 'advisor', syncedAt: now } },
          { upsert: true },
        );
        seen.add(a.v);
      }
      for (const p of sales) {
        if (seen.has(p.v)) continue;
        if (!dryRun) await collections.tbMechanics().updateOne(
          { _id: `${code}:${p.v}` },
          { $set: { _id: `${code}:${p.v}`, mechanicCode: p.v, name: p.t, storeCode: code, role: 'salesperson', syncedAt: now } },
          { upsert: true },
        );
      }
      console.log(`${dryRun ? '  akan disalin:' : '✓'} ${advisors.length} advisor, ${sales.length} salesperson${advisors.length ? `: ${advisors.map((a) => a.t).join(', ')}` : ''}`);
      if (dryRun) console.log(`\n✓ UJI COBA SELESAI — semuanya bisa dijalankan, dan TIDAK ADA yang ditulis.`);
      if (!advisors.length) {
        console.log('⚠ Turboly belum punya Service Advisor untuk store ini — daftarkan orangnya dulu (Setup → Users), lalu jalankan ulang.');
      }
    } finally {
      await session.dispose().catch(() => {});
    }
  } finally {
    await close().catch(() => {});
  }
}

// Playwright keeps the event loop alive; exit explicitly so a green run ends.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error(e); process.exit(1); });
