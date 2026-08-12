// Load the FULL Turboly product list (~/turboly-export/all_products.csv,
// generated from the Product List download) into tb_products.
//
//   node --env-file=<env> scripts/import-all-products.mjs
//
// import-turboly-export.mjs owns the nine tile categories (OLM, BAN, …) and
// runs after this one wins ties; this fills in everything ELSE the tenant
// sells — air filters, accessories, sparepart lain — so the form's Sparepart
// rows (cat=ALL search) can find any product, and the push worker's goods
// set recognises the SKU and bills it on the sparepart tab. Existing docs
// keep their tile category; only genuinely new SKUs are inserted here, with
// the catalogue's own Type as the category.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, close, getDb } from '../packages/core/dist/index.js';

const PATH = join(process.env.HOME ?? '', 'turboly-export', 'all_products.csv');

// What the counter TYPES vs what the catalogue CALLS it. Appended to the
// search text so 'aki gs' finds a BATTERY and 'oli castrol' finds an OLM.
export const SEARCH_ALIASES = {
  BATTERY: 'aki accu',
  OLM: 'oli mesin',
  OFL: 'filter oli',
  ATF: 'oli transmisi atf',
  OLI_ATF: 'oli transmisi',
  BOHLAM: 'lampu bulb',
};

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

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const col = getDb().collection('tb_products');
const have = new Set((await col.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));

const rows = parseCsv(readFileSync(PATH, 'utf8')).filter((r) => r.SKU && !have.has(r.SKU));
const ops = rows.map((r) => ({
  updateOne: {
    filter: { _id: r.SKU },
    update: {
      $set: {
        name: r.Name ?? '',
        brand: r.Brand || null,
        category: (r.Type || 'SPAREPART').replace(/\s+/g, '_'),
        // Category included so 'aki gs' or 'filter udara' match even when
        // the product NAME is English ('GS Astra…', 'Air Filter…').
        search: `${r.SKU} ${r.Name ?? ''} ${r.Brand ?? ''} ${(r.Type || '').replace(/_/g, ' ')} ${SEARCH_ALIASES[(r.Type || '').replace(/\s+/g, '_')] ?? ''}`.trim().toLowerCase(),
        syncedAt: new Date().toISOString(),
      },
    },
    upsert: true,
  },
}));
if (ops.length) await col.bulkWrite(ops, { ordered: false });
console.log(`tb_products: ${ops.length} new products added (had ${have.size}, ` +
  `catalogue ${rows.length + (parseCsv(readFileSync(PATH, 'utf8')).length - rows.length)} rows)`);
console.log('total now:', await col.countDocuments({}));
await close();
