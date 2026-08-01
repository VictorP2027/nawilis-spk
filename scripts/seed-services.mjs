// Map each SPK service code -> a REAL Turboly service SKU (harvested from the live
// service picker) and seed tb_service_products + service_sku_map, replacing the
// DEMO placeholders. Search is by SKU code (unique). SANDBOX SKUs — re-map for prod.
import { connect, close, collections } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';

// SPK code -> Turboly SKU code (unique search key). '*' entries are best-guess (flag).
const MAP = {
  SPOORING: 'SPO-NAW-000',
  BALANCING: 'BAL-NAW-STD',
  BALANCING_ON_CAR: 'BAL-NAW-STD', // * no distinct on-car service in sandbox → Balancing
  OLI: 'JAS-NAW-JGO',
  ENGINE_FLUSH: 'EFL-NAW-EF',
  TUNE_UP_CARBON_CLEAN: 'TUN-NAW-PTU', // * Power Tune Up
  AUTM_TRANS_FLUSH: 'ATF-NAW-ATFS',
  KURAS_RADIATOR: 'JAS-NAW-FR',
  SERVICE_REM: 'SER-NAW-SR',
  BUBUT_REM: 'BUB-NAW-BUBR',
  BAN: 'BPB-NAW-BPB', // * Bongkar Pasang Ban
  NITROGEN: 'NIT-NAW-NF', // * Nitrogen FREE
};

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const now = new Date().toISOString();
// remove DEMO placeholders
const dp = await collections.tbServiceProducts().deleteMany({ _id: { $regex: '^DEMO-' } });
for (const [code, sku] of Object.entries(MAP)) {
  await collections.tbServiceProducts().updateOne({ _id: sku }, { $set: { _id: sku, sku, name: sku, type: 'service', taxCode: 'PPN', price: 0, masterDurationMin: 30, storeCode: null, syncedAt: now } }, { upsert: true });
  await collections.serviceSkuMap().updateOne({ _id: `*:${code}` }, { $set: { _id: `*:${code}`, branchCode: null, serviceCode: code, sku, matchScore: 1, confirmed: true, updatedAt: now } }, { upsert: true });
}
console.log(`removed ${dp.deletedCount} DEMO products; mapped ${Object.keys(MAP).length} services to real Turboly SKUs`);
await close();
