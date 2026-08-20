import { connect, close, collections } from '@spk/core';
import { config } from './config.js';

/**
 * TEACH THE MIRROR ONE SERVICE SKU — `--sku=HSB-NAW-HSB --name="High Speed Balance"`.
 *
 * tb_service_products is the local copy of Turboly's service catalogue. It is
 * loaded by a manual export/import (seed:turboly) — sync-catalogs.mjs does NOT
 * refresh it — so a SKU created in Turboly today is unknown here until someone
 * re-imports. Two things depend on that:
 *
 *  - validateLayer2 BLOCKS an SPK whose SKU the mirror does not know, unless the
 *    mirror is older than 24h, in which case it only warns. A service added to
 *    a form default while missing here is therefore a landmine: harmless until
 *    the day the catalogue is re-imported, then it refuses SPKs at the counter.
 *  - the pusher types the mirror's NAME into Turboly's picker; with no entry it
 *    searches the raw SKU instead.
 *
 * syncedAt is deliberately copied from the mirror's newest existing row rather
 * than set to now: `serviceProductsStale` is computed from the NEWEST timestamp
 * in the collection, so stamping one fresh row would flip the whole mirror to
 * "fresh" and turn every OTHER missing SKU from a warning into a block.
 *
 *   node --import tsx apps/worker/src/service-product-add.ts --sku=HSB-NAW-HSB --name="High Speed Balance"
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function main(): Promise<void> {
  const sku = (arg('sku') ?? '').trim().toUpperCase();
  const name = (arg('name') ?? '').trim();
  const tax = (arg('tax') ?? 'PPN').trim();
  if (!sku || !name) {
    console.error('butuh --sku=SKU --name="Nama Jasa"');
    process.exitCode = 1;
    return;
  }
  await connect(config.mongoUri, config.mongoDb);
  try {
    const col = collections.tbServiceProducts();
    const existing = await col.findOne({ $or: [{ sku }, { _id: sku }] });
    if (existing) {
      console.log(`· ${sku} sudah ada di mirror (${existing.name}) — tidak diubah`);
      return;
    }
    const newest = await col.find({}, { projection: { syncedAt: 1 }, sort: { syncedAt: -1 }, limit: 1 }).toArray();
    const syncedAt = newest[0]?.syncedAt ?? new Date(0).toISOString();
    await col.updateOne(
      { _id: sku },
      { $set: { sku, name, type: 'service', taxCode: tax, price: 0, masterDurationMin: 0, storeCode: null, syncedAt } },
      { upsert: true },
    );
    const check = await col.findOne({ sku });
    console.log(`✓ ${sku} → mirror: ${check?.name}`);
    console.log(`  syncedAt disamakan dengan katalog yang ada (${syncedAt}) — kesegaran mirror sengaja TIDAK diubah`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

void main();
