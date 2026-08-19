import { connect, close, getDb } from '@spk/core';
import { config } from './config.js';

/**
 * ADD ONE MODEL TO THE FORM'S PICKER — `--make=JAECOO --model=J7 [--kind=car]`.
 *
 * The Tipe picker on /  and /checkgo is served by /api/vehicle-models, which
 * reads the `vehicle_models_map` document in Mongo (byMake, plus byMakeCar /
 * byMakeMotor for the four names that are both a car and a bike brand). That
 * document was harvested from Turboly's own /vehicles/new form; the JSON files
 * under data/ are a snapshot of that harvest and are read by nothing at
 * runtime — editing them does not change what staff see.
 *
 * This adds a single model to that document: sorted, de-duplicated, and
 * idempotent, so running it twice changes nothing.
 *
 * It does NOT teach Turboly the model. If Turboly's own catalogue has never
 * heard of it, the push will say so when the first such car is sent.
 *
 *   node --import tsx apps/worker/src/vehicle-model-add.ts --make=JAECOO --model=J7 --kind=car
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

type Map_ = Record<string, string[]>;
interface Doc { _id: string; byMake: Map_; byMakeCar?: Map_; byMakeMotor?: Map_ }

async function main(): Promise<void> {
  const make = (arg('make') ?? '').trim().toUpperCase();
  const model = (arg('model') ?? '').trim().toUpperCase();
  const kind = (arg('kind') ?? 'car').trim().toLowerCase();
  if (!make || !model) {
    console.error('butuh --make=MERK --model=TIPE [--kind=car|motorcycle|both]');
    process.exitCode = 1;
    return;
  }
  await connect(config.mongoUri, config.mongoDb);
  try {
    const col = getDb().collection<Doc>('vehicle_models_map');
    const doc = await col.findOne({ _id: 'byMake' });
    if (!doc) throw new Error('dokumen vehicle_models_map/byMake tidak ada — daftar merk belum pernah dipanen');

    const fields = kind === 'motorcycle' ? ['byMake', 'byMakeMotor'] : kind === 'both' ? ['byMake', 'byMakeCar', 'byMakeMotor'] : ['byMake', 'byMakeCar'];
    const set: Record<string, string[]> = {};
    for (const field of fields) {
      const map = (doc as unknown as Record<string, Map_ | undefined>)[field];
      if (!map) { console.log(`  · ${field}: tidak ada di dokumen — dilewati`); continue; }
      const key = Object.keys(map).find((k) => k.toUpperCase() === make);
      if (!key) { console.log(`  · ${field}: merk ${make} belum ada — dilewati (tambahkan merknya dulu di Turboly)`); continue; }
      const before = map[key] ?? [];
      if (before.some((m) => m.toUpperCase() === model)) { console.log(`  · ${field}: ${make} sudah punya ${model}`); continue; }
      const after = [...before, model].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      set[`${field}.${key}`] = after;
      console.log(`  + ${field}.${key}: ${before.join(', ')} → ${after.join(', ')}`);
    }
    if (!Object.keys(set).length) { console.log('tidak ada yang perlu diubah'); return; }
    await col.updateOne({ _id: 'byMake' }, { $set: set });
    const check = await col.findOne({ _id: 'byMake' });
    const key = Object.keys(check?.byMake ?? {}).find((k) => k.toUpperCase() === make);
    console.log(`\n✓ ${make} sekarang: ${(key ? check?.byMake[key] : []) ?? []}`);
    console.log(`  (mobil: ${(key && check?.byMakeCar?.[key]) ? check.byMakeCar[key].join(', ') : '-'})`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

void main();
