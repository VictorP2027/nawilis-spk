// Load the scraped Turboly export (~/turboly-export) into the option mirrors.
//
//   node --env-file=.env scripts/import-turboly-export.mjs [dir]
//
// Two things come out of it:
//
//   service_options — per SPK card, the REAL service-SKU variants scraped from
//     the tenant (was: one hand-seeded default each). The card→prefix rules are
//     the human-curated table in pekerjaan_options.md, frozen here; the SKUs
//     themselves come from service_products_by_type.csv, so a re-scrape
//     refreshes the lists without touching the rules. An existing defaultSku is
//     preserved when it still exists — branches are used to their defaults.
//
//   tb_products — every product the sheet asks a brand/type for (oils, tires,
//     brake parts, coolant, busi …), one doc per SKU with a `category` the
//     forms' suggestion boxes filter on. ~3.9k rows, so it lives in Mongo and
//     is searched through /api/products, never shipped to the client whole.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, close, getDb } from '../packages/core/dist/index.js';

const DIR = process.argv[2] ?? join(process.env.HOME ?? '', 'turboly-export');

/** Small CSV parser — quoted fields with commas exist in this export. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const csv = (name) => parseCsv(readFileSync(join(DIR, name), 'utf8'));

// ── service_options: card → service-SKU rules (pekerjaan_options.md, frozen) ──
const CARD_RULES = [
  { code: 'SPOORING', prefixes: ['SPO-'] },
  { code: 'BALANCING', prefixes: ['BAL-'] },
  { code: 'BALANCING_ON_CAR', prefixes: ['OTL-'] },
  { code: 'OLI', skus: ['JAS-NAW-JGO', 'JAS-NAW-JGOF', 'JAS-NAWJAS-JGOM'] },
  { code: 'ENGINE_FLUSH', prefixes: ['EFL-'], skus: ['JAS-NAW-PEF'] },
  { code: 'TUNE_UP_CARBON_CLEAN', prefixes: ['TUN-', 'CAR-'] },
  { code: 'AUTM_TRANS_FLUSH', prefixes: ['ATF-'] },
  { code: 'KURAS_RADIATOR', skus: ['JAS-NAW-FR', 'JAS-NAWJAS-JKR', 'JAS-NAW-RAD'] },
  { code: 'SERVICE_REM', prefixes: ['SER-', 'KMR-'] },
  { code: 'BUBUT_REM', prefixes: ['BUB-'] },
  { code: 'BAN', prefixes: ['BPB-', 'TAM-', 'PRE-'] },
  { code: 'NITROGEN', prefixes: ['NIT-'] },
];

// ── product files → tb_products categories ───────────────────────────────
const PRODUCT_FILES = [
  ['olm_products.csv', 'OLM'],
  ['atf_products.csv', 'ATF'],
  ['ban_products.csv', 'BAN'],
  ['busi_products.csv', 'BUSI'],
  ['coolant_products.csv', 'COOLANT'],
  ['kanvas_rem_products.csv', 'KANVAS_REM'],
  ['minyak_rem_products.csv', 'MINYAK_REM'],
];

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const db = getDb();

// service_options -----------------------------------------------------------
const serviceSkus = csv('service_products_by_type.csv'); // SKU,Name,Type,Price
const existing = new Map((await db.collection('service_options').find({}).toArray()).map((r) => [r._id, r]));
let optTotal = 0;
for (const rule of CARD_RULES) {
  const bySku = new Map();
  for (const r of serviceSkus) {
    const sku = r.SKU ?? '';
    if (rule.prefixes?.some((p) => sku.startsWith(p))) bySku.set(sku, r);
  }
  for (const sku of rule.skus ?? []) {
    const r = serviceSkus.find((x) => x.SKU === sku);
    if (r) bySku.set(sku, r);
    else console.log(`  ⚠ ${rule.code}: listed SKU ${sku} not in service_products_by_type.csv — skipped`);
  }
  const options = [...bySku.values()].map((r) => ({ sku: r.SKU, label: `${r.SKU} ${r.Name}` }));
  if (!options.length) { console.log(`  ⚠ ${rule.code}: NO service SKUs matched — row left untouched`); continue; }
  const prev = existing.get(rule.code);
  const defaultSku = options.some((o) => o.sku === prev?.defaultSku) ? prev.defaultSku : options[0].sku;
  await db.collection('service_options').updateOne(
    { _id: rule.code },
    { $set: { defaultSku, options, syncedAt: new Date().toISOString(), source: 'turboly-export' } },
    { upsert: true },
  );
  optTotal += options.length;
  console.log(`service_options ${rule.code.padEnd(22)} ${String(options.length).padStart(3)} SKUs (default ${defaultSku})`);
}

// tb_products ---------------------------------------------------------------
let prodTotal = 0;
for (const [file, category] of PRODUCT_FILES) {
  const rows = csv(file);
  const ops = rows
    .filter((r) => (r.SKU ?? '') !== '')
    .map((r) => ({
      updateOne: {
        filter: { _id: r.SKU },
        update: {
          $set: {
            name: r.Name ?? '',
            brand: r.Brand ?? null,
            category,
            // Search key: everything a counter person might type, one lowercase field.
            search: `${r.SKU} ${r.Name ?? ''} ${r.Brand ?? ''}`.toLowerCase(),
            syncedAt: new Date().toISOString(),
          },
        },
        upsert: true,
      },
    }));
  if (ops.length) await db.collection('tb_products').bulkWrite(ops, { ordered: false });
  prodTotal += ops.length;
  console.log(`tb_products ${category.padEnd(12)} ${String(ops.length).padStart(5)} from ${file}`);
}
await db.collection('tb_products').createIndex({ category: 1, search: 1 }, { name: 'ix_products_search' });

console.log(`\nDONE — ${optTotal} service SKUs across ${CARD_RULES.length} cards, ${prodTotal} products`);
await close();
process.exit(0);
