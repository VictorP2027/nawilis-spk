import { sb } from '../client.js';
import { REF_SERVICES } from '@spk/core';

/** Local DEMO seed on Supabase so the form parks at awaiting_assignment. */
async function main(): Promise<void> {
  const now = new Date().toISOString();
  const BRANCH = 'NWL-BKS';
  const c = sb();

  await c.from('tb_stores').upsert({ branch_code: BRANCH, doc: { _id: BRANCH, turbolyStoreId: 'demo-7', turbolyStoreName: 'Nawilis Bekasi', syncedAt: now } });
  await c.from('tb_mechanics').upsert({ code: 'DEMO-ADV', store_code: null, doc: { _id: 'DEMO-ADV', mechanicCode: 'DEMO-ADV', name: 'Demo Advisor', storeCode: null, role: 'advisor', syncedAt: now } });

  for (const s of REF_SERVICES) {
    const sku = `DEMO-${s.code}`;
    await c.from('tb_service_products').upsert({ sku, store_code: null, doc: { _id: sku, sku, name: s.label, type: 'service', taxCode: 'PPN', price: 350000, masterDurationMin: 30, storeCode: null, syncedAt: now } });
    await c.from('service_sku_map').upsert({ id: `*:${s.code}`, service_code: s.code, branch_code: null, sku, confirmed: true });
  }

  await c.from('vehicles').upsert({
    id: 'veh_B1234XY', plate_full: 'B1234XY', plate_variants: ['B1234XY'],
    doc: { _id: 'veh_B1234XY', plateFull: 'B1234XY', plateVariants: ['B1234XY'], merk: 'TOYOTA', tipe: 'AVANZA', tahun: 2019, warna: 'Silver', lastKm: 10000, lastSeenAt: now, lastBranch: BRANCH, visitCount: 1, customerRefs: [] },
  });

  console.log('✓ demo mirror seeded on Supabase (NWL-BKS, 12 placeholder SKUs, "Demo Advisor")');
  console.log('✓ returning vehicle B 1234 XY (last 10.000 km)');
}
main().catch((e) => { console.error(e); process.exit(1); });
