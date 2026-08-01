import { connect, close, ensureIndexes, collections } from '../mongo.js';
import { REF_SERVICES } from '../refdata.js';

/**
 * Local DEMO seed so you can try the form → MongoDB flow end to end without a
 * real Turboly export. Seeds one branch's mirror with placeholder SKUs + a demo
 * advisor, and a returning vehicle so a matching submission sails through
 * validation and parks at `awaiting_assignment`.
 *
 * These SKUs are PLACEHOLDERS — fine for capture/parking, NOT for a real push.
 * For real pushes, import your Turboly export (seed:turboly).
 *
 *   npm run seed:demo -w @spk/core
 */
async function main(): Promise<void> {
  await connect();
  await ensureIndexes();
  const now = new Date().toISOString();
  const BRANCH = 'NWL-BKS';

  // Real Turboly sandbox store id for Nawilis Bekasi (harvested), so RPA can select it.
  await collections.tbStores().updateOne({ _id: BRANCH }, { $set: { _id: BRANCH, turbolyStoreId: '8339', turbolyStoreName: 'Nawilis Bekasi', syncedAt: now } }, { upsert: true });
  await collections.tbMechanics().updateOne({ _id: 'DEMO-ADV' }, { $set: { _id: 'DEMO-ADV', mechanicCode: 'DEMO-ADV', name: 'Demo Advisor', storeCode: null, role: 'advisor', syncedAt: now } }, { upsert: true });

  for (const s of REF_SERVICES) {
    const sku = `DEMO-${s.code}`;
    await collections.tbServiceProducts().updateOne({ _id: sku }, { $set: { _id: sku, sku, name: s.label, type: 'service', taxCode: 'PPN', price: 350000, masterDurationMin: 30, storeCode: null, syncedAt: now } }, { upsert: true });
    await collections.serviceSkuMap().updateOne({ _id: `*:${s.code}` }, { $set: { _id: `*:${s.code}`, branchCode: null, serviceCode: s.code, sku, matchScore: 1, confirmed: true, updatedAt: now } }, { upsert: true });
  }

  // A returning vehicle so the demo submission isn't a first-visit (which always
  // asks to confirm the odometer).
  await collections.vehicles().updateOne(
    { _id: 'veh_B1234XY' },
    { $set: { plateFull: 'B1234XY', plateVariants: ['B1234XY'], merk: 'TOYOTA', tipe: 'AVANZA', tahun: 2019, warna: 'Silver', lastKm: 10000, lastSeenAt: now, lastBranch: BRANCH }, $setOnInsert: { _id: 'veh_B1234XY', visitCount: 1, customerRefs: [] } },
    { upsert: true },
  );

  console.log('✓ demo mirror seeded for NWL-BKS (12 placeholder SKUs, advisor "Demo Advisor")');
  console.log('✓ returning vehicle B 1234 XY (last 10.000 km)');
  console.log('Try: branch Bekasi, plate B1234XY, KM ≥ 10.000, advisor "Demo Advisor".');
  await close();
}
main().catch((e) => { console.error(e); process.exit(1); });
