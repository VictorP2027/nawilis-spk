import { MongoClient } from 'mongodb';
const uri = process.env.MONGODB_URI!;
let c: MongoClient | null = null;
for (let i = 0; i < 30; i++) {
  try { const t = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 }); await t.connect(); c = t; break; }
  catch (e) { console.log(`[${new Date().toISOString()}] attempt ${i + 1}/30: ${(e as Error).message.slice(0, 70)}`); await new Promise((r) => setTimeout(r, 60_000)); }
}
if (!c) { console.log('GAVE UP after 30 attempts'); process.exit(1); }
const src = c.db('spk'); const dst = c.db('spk_v2');
for (const { name } of await src.listCollections().toArray()) {
  const docs = await src.collection(name).find({}).toArray();
  await dst.collection(name).drop().catch(() => {});
  if (docs.length) await dst.collection(name).insertMany(docs as never[]);
  const idx = (await src.collection(name).listIndexes().toArray()).filter((i) => i.name !== '_id_');
  for (const i of idx) {
    const { key, name: iname, unique, sparse, partialFilterExpression } = i as never as Record<string, never>;
    await dst.collection(name).createIndex(key, { name: iname, ...(unique ? { unique } : {}), ...(sparse ? { sparse } : {}), ...(partialFilterExpression ? { partialFilterExpression } : {}) }).catch(() => {});
  }
  console.log(`${name.padEnd(22)} ${String(docs.length).padStart(5)} docs, ${idx.length} idx`);
}
console.log('CLONE DONE — spk_v2 collections:', (await dst.listCollections().toArray()).length);
await c.close(); process.exit(0);
