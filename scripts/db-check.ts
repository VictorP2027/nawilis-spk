import { MongoClient } from 'mongodb';

/** Connect to whatever MONGODB_URI points at (local or Atlas) and report health. */
async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB ?? 'spk';
  const masked = uri.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:****@');

  console.log('MONGODB_URI :', masked);
  console.log('database    :', dbName);
  console.log('type        :', uri.startsWith('mongodb+srv') || uri.includes('mongodb.net') ? 'Atlas (cloud / web-based)' : 'standard / local');

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
    console.log('status      : ✓ connected + ping OK');
    const cols = await client.db(dbName).listCollections().toArray();
    console.log('collections :', cols.map((c) => c.name).sort().join(', ') || '(none yet)');
    const n = await client.db(dbName).collection('spk').countDocuments().catch(() => 0);
    console.log('spk records :', n);
  } catch (e) {
    console.error('status      : ✗ FAILED —', (e as Error).message);
    console.error('\nCommon fixes: (1) Atlas → Network Access: add your IP (or 0.0.0.0/0 for dev);');
    console.error('(2) check DB user + password in the URI; (3) URL-encode special chars in the password.');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
