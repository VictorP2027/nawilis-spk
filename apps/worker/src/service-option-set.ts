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
    const row = await col.findOne({ _id: code });
    if (!row) throw new Error(`service_options/${code} tidak ada — kode jasa itu belum punya daftar varian`);

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

    await col.updateOne({ _id: code }, { $set: { defaultSku, options } });
    console.log(`\n✓ ${code}: default ${row.defaultSku} → ${defaultSku}`);
    for (const o of options) console.log(`   ${o.sku === defaultSku ? '●' : '·'} ${o.label}`);

    // Does the push know these SKUs? Not fatal — the RPA searches Turboly by SKU
    // when the mirror has no name — but worth knowing before the first car.
    for (const o of adds) {
      const known = await collections.tbServiceProducts().findOne({ _id: o.sku });
      console.log(`   ${known ? '✓' : '⚠'} ${o.sku} ${known ? `ada di katalog (${known.name})` : 'BELUM ada di mirror katalog — jalankan sync kalau push-nya gagal'}`);
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

void main();
