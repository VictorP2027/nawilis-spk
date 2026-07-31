import { readFile } from 'node:fs/promises';
import { connect, close, collections } from '../mongo.js';
import { REF_BRANCHES, REF_SERVICES } from '../refdata.js';
import { jaroWinkler } from '../indonesia.js';

/**
 * Import Turboly master data from a UI export (obtained WITHOUT scraping — the
 * Setup/Reports export buttons). Populates tb_stores, tb_service_products,
 * tb_mechanics, and builds an UNCONFIRMED service_sku_map by fuzzy-matching each
 * SPK service label to a Turboly Service Product name. A human confirms the map
 * in the admin console before it is trusted for pushes.
 *
 * Usage:  npm run seed:turboly -- ./turboly-export.json
 *
 * Expected JSON shape:
 * {
 *   "stores":          [{ "branchCode"?: "NWL-BKS", "turbolyStoreId": "42", "turbolyStoreName": "Nawilis Bekasi" }],
 *   "serviceProducts": [{ "sku": "JASA-SPOOR", "name": "Spooring", "type": "service", "taxCode": "PPN", "price": 350000, "masterDurationMin": 30, "storeCode": null }],
 *   "mechanics":       [{ "mechanicCode": "M001", "name": "Budi", "storeCode": null, "role": "advisor" }]
 * }
 */
interface Export {
  stores: Array<{ branchCode?: string; turbolyStoreId: string; turbolyStoreName: string }>;
  serviceProducts: Array<{ sku: string; name: string; type?: string; taxCode?: string; price?: number; masterDurationMin?: number; storeCode?: string | null }>;
  mechanics: Array<{ mechanicCode: string; name: string; storeCode?: string | null; role?: string }>;
}

function matchBranch(storeName: string): string | null {
  let best: string | null = null;
  let score = 0;
  for (const b of REF_BRANCHES) {
    const s = jaroWinkler(storeName.toUpperCase(), b.turbolyStoreNameGuess.toUpperCase());
    if (s > score) {
      score = s;
      best = b.code;
    }
  }
  return score >= 0.85 ? best : null;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npm run seed:turboly -- ./turboly-export.json');
    process.exit(1);
  }
  const data = JSON.parse(await readFile(path, 'utf8')) as Export;
  await connect();
  const now = new Date().toISOString();

  // Stores
  for (const s of data.stores) {
    const branchCode = s.branchCode ?? matchBranch(s.turbolyStoreName);
    if (!branchCode) {
      console.warn(`⚠ store "${s.turbolyStoreName}" did not match any branch — set branchCode explicitly`);
      continue;
    }
    await collections.tbStores().updateOne(
      { _id: branchCode },
      { $set: { _id: branchCode, turbolyStoreId: s.turbolyStoreId, turbolyStoreName: s.turbolyStoreName, syncedAt: now } },
      { upsert: true },
    );
  }

  // Service products
  for (const p of data.serviceProducts) {
    await collections.tbServiceProducts().updateOne(
      { _id: p.sku },
      { $set: { _id: p.sku, sku: p.sku, name: p.name, type: p.type ?? null, taxCode: p.taxCode ?? null, price: p.price ?? null, masterDurationMin: p.masterDurationMin ?? null, storeCode: p.storeCode ?? null, syncedAt: now } },
      { upsert: true },
    );
  }

  // Mechanics / advisors / salespeople
  for (const m of data.mechanics) {
    await collections.tbMechanics().updateOne(
      { _id: m.mechanicCode },
      { $set: { _id: m.mechanicCode, mechanicCode: m.mechanicCode, name: m.name, storeCode: m.storeCode ?? null, role: m.role ?? null, syncedAt: now } },
      { upsert: true },
    );
  }

  // Build UNCONFIRMED service→SKU map (tenant-wide) by fuzzy name match.
  let mapped = 0;
  for (const svc of REF_SERVICES) {
    let bestSku: string | null = null;
    let bestScore = 0;
    for (const p of data.serviceProducts) {
      const s = jaroWinkler(svc.label.toUpperCase(), p.name.toUpperCase());
      if (s > bestScore) {
        bestScore = s;
        bestSku = p.sku;
      }
    }
    if (bestSku && bestScore >= 0.8) {
      await collections.serviceSkuMap().updateOne(
        { _id: `*:${svc.code}` },
        { $set: { _id: `*:${svc.code}`, branchCode: null, serviceCode: svc.code, sku: bestSku, matchScore: bestScore, confirmed: false, updatedAt: now } },
        { upsert: true },
      );
      mapped++;
      console.log(`  ${svc.code}  →  ${bestSku}  (${(bestScore * 100).toFixed(0)}%)  [UNCONFIRMED]`);
    } else {
      console.warn(`  ${svc.code}  →  NO MATCH (best ${(bestScore * 100).toFixed(0)}%) — map manually`);
    }
  }

  console.log(`\n✓ stores=${data.stores.length} products=${data.serviceProducts.length} mechanics=${data.mechanics.length} skuMap=${mapped}/${REF_SERVICES.length}`);
  console.log('⚠ SKU map is UNCONFIRMED. Confirm in the admin console before enabling RPA push.');
  await close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
