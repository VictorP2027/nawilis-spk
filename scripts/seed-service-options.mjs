// Seed the per-service Turboly options catalog (service_options collection) so the
// form can offer a dropdown of variants per job, defaulting to the default SKU.
// Source: data/turboly-service-options.json (harvested from Turboly). SANDBOX — re-harvest for prod.
import fs from 'node:fs';
import { connect, close, getDb } from '../packages/core/dist/index.js';

const data = JSON.parse(fs.readFileSync('data/turboly-service-options.json', 'utf8'));
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const col = getDb().collection('service_options');
const now = new Date().toISOString();
let n = 0;
for (const [code, { defaultSku, options }] of Object.entries(data)) {
  await col.updateOne({ _id: code }, { $set: { _id: code, defaultSku, options, syncedAt: now } }, { upsert: true });
  n++;
}
console.log(`seeded ${n} service_options docs`);
await close();
