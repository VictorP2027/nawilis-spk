import { connect, close, getDb, collections } from '@spk/core';
import { config } from './config.js';

/**
 * SET THE TURBOLY VARIANTS FOR ONE SPK JOB — and which one is picked by default.
 *
 * The dropdown under each job on the SPK form is served by /api/service-options,
 * which reads the `service_options` collection ({_id: SERVICE_CODE, defaultSku,
 * options[]}). data/turboly-service-options.json is only a snapshot of it and is
 * read by nothing at runtime.
 *
 * Why this exists: a paper SPK saying "Balancing On The Car" was being entered
 * into Turboly as "Balancing OTC Langsung" because that was the default here,
 * when the branch meant High Speed Balance.
 *
 *   node --import tsx apps/worker/src/service-option-set.ts \
 *     --code=BALANCING_ON_CAR --default=HSB-NAW-HSB \
 *     --add="HSB-NAW-HSB=High Speed Balance" --add="HSB-NAW-VIP=High Speed Balance VIP"
 *
 * Existing options are KEPT (the old choice stays available); an added SKU that
 * is already listed is left alone. Idempotent.
 */
const argAll = (k: string): string[] => process.argv.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
const arg = (k: string): string | undefined => argAll(k)[0];
const has = (k: string): boolean => process.argv.includes(`--${k}`);

interface Opt { sku: string; label: string }
interface Row { _id: string; defaultSku: string; options: Opt[] }

async function main(): Promise<void> {
  const code = (arg('code') ?? '').trim().toUpperCase();
  const def = (arg('default') ?? '').trim().toUpperCase();
  const adds = argAll('add')
    .map((s) => {
      const [sku, ...rest] = s.split('=');
      return { sku: (sku ?? '').trim().toUpperCase(), label: rest.join('=').trim() };
    })
    .filter((o) => o.sku);
  if (!code) {
    console.error('butuh --code=KODE_JASA [--default=SKU] [--add="SKU=Nama"]…');
    process.exitCode = 1;
    return;
  }
  await connect(config.mongoUri, config.mongoDb);
  try {
    const col = getDb().collection<Row>('service_options');
    const existing = await col.findOne({ _id: code });
    /**
     * A code with no row yet.
     *
     * Normally that means a typo, and refusing is right — silently creating
     * `SPOORNG` would leave a dropdown nobody can find. But the SPK form's
     * "Pekerjaan lain (tulis / pilih)" box offers the union of EVERY option in
     * this collection, so a job that has no tile of its own still needs a row
     * here to be selectable at all. That is how Periodic Maintenance
     * (TPI-NAWJAS-PM) is offered without adding a 16th button to the grid.
     * --create says the new code is deliberate.
     */
    const creating = !existing && has('create');
    if (!existing && !creating) {
      throw new Error(`service_options/${code} tidak ada — kode jasa itu belum punya daftar varian (pakai --create kalau memang kode baru)`);
    }
    const row = existing ?? { _id: code, defaultSku: '', options: [] as Array<{ sku: string; label: string }> };
    if (creating) console.log(`· ${code} belum ada — dibuat baru (--create)`);

    const options = [...row.options];
    for (const a of adds) {
      if (options.some((o) => o.sku.toUpperCase() === a.sku)) { console.log(`  · ${a.sku} sudah ada`); continue; }
      options.push({ sku: a.sku, label: a.label ? `${a.sku} ${a.label}` : a.sku });
      console.log(`  + ditambahkan: ${a.sku}${a.label ? ` (${a.label})` : ''}`);
    }
    // The default must be one of the options, or the form would open on a value
    // its own dropdown does not contain.
    const defaultSku = def || row.defaultSku;
    if (!options.some((o) => o.sku.toUpperCase() === defaultSku.toUpperCase())) {
      throw new Error(`default ${defaultSku} tidak ada di daftar pilihan — tambahkan dulu dengan --add`);
    }
    /**
     * Order matters: the counter reads this dropdown top-down under time
     * pressure, so the variants that belong together should sit together.
     * `--order=A,B` puts those SKUs first, in that sequence; everything else
     * keeps its existing order below. With no --order, the default goes first.
     */
    const wanted = (arg('order') ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    const rank = (sku: string): number => {
      const i = wanted.indexOf(sku.toUpperCase());
      if (i >= 0) return i;
      return wanted.length + (sku.toUpperCase() === defaultSku.toUpperCase() ? -0.5 : 0.5);
    };
    options.sort((a, b) => rank(a.sku) - rank(b.sku));

    await col.updateOne({ _id: code }, { $set: { _id: code, defaultSku, options } }, { upsert: creating });
    console.log(`\n✓ ${code}: default ${row.defaultSku || '(baru)'} → ${defaultSku}`);
    for (const o of options) console.log(`   ${o.sku === defaultSku ? '●' : '·'} ${o.label}`);

    /**
     * Is this SKU in the catalogue mirror — and does that matter TODAY?
     *
     * validateLayer2 looks the SKU up in the mirror keyed by its `sku` FIELD
     * (mirror.ts:37), not by _id. If it is missing AND the mirror is fresh
     * (< 24h old) the finding is BLOCK: the SPK is refused at the counter. If
     * the mirror is older than that, the same miss degrades to WARN and the SPK
     * goes through. So the answer to "is this default safe" is both facts
     * together, and neither is guessable from here.
     */
    const newest = await collections
      .tbServiceProducts()
      .find({}, { projection: { syncedAt: 1 }, sort: { syncedAt: -1 }, limit: 1 })
      .toArray();
    const newestSync = Date.parse(newest[0]?.syncedAt ?? '') || 0;
    const ageH = newestSync ? Math.round((Date.now() - newestSync) / 3600_000) : -1;
    const stale = newestSync === 0 || Date.now() - newestSync > 24 * 3600_000;
    console.log(`\n   katalog jasa terakhir diperbarui: ${newestSync ? `${ageH} jam lalu` : 'TIDAK PERNAH'} → SKU asing = ${stale ? 'WARN (SPK tetap jalan)' : 'BLOCK (SPK ditolak di counter)'}`);
    for (const o of [...adds, { sku: defaultSku, label: '' }]) {
      const known = await collections.tbServiceProducts().findOne({ $or: [{ sku: o.sku }, { _id: o.sku }] });
      const verdict = known ? `ada di katalog (${known.name})` : stale ? 'tidak ada di mirror — hanya WARN, SPK tetap jalan' : 'TIDAK ADA di mirror dan mirror masih baru → SPK AKAN DITOLAK';
      console.log(`   ${known ? '✓' : stale ? '⚠' : '✗'} ${o.sku} ${verdict}`);
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

void main();
