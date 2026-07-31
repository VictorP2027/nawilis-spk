/**
 * Direct local MongoDB — no Docker. Runs a real mongod (binary already fetched
 * by mongodb-memory-server) on a FIXED port with a PERSISTENT data dir, so data
 * survives restarts. Keep this running in one terminal; point the app at
 * mongodb://localhost:27017.
 *
 *   node scripts/dev-mongo.mjs           # port 27017, ./.mongo-data
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdir } from 'node:fs/promises';

const PORT = Number(process.env.DEV_MONGO_PORT ?? 27017);
const DBPATH = process.env.DEV_MONGO_PATH ?? './.mongo-data';

await mkdir(DBPATH, { recursive: true });

const server = await MongoMemoryServer.create({
  instance: {
    port: PORT,
    dbPath: DBPATH,
    // wiredTiger PERSISTS to disk; the MMS default (ephemeralForTest) is memory-only.
    storageEngine: 'wiredTiger',
  },
});

console.log(`\n✓ MongoDB running (persistent) at ${server.getUri()}`);
console.log(`  data dir: ${DBPATH}`);
console.log('  leave this running; Ctrl-C to stop.\n');

async function shutdown() {
  console.log('\nstopping mongod (data kept)…');
  await server.stop({ doCleanup: false, force: false });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// keep the process alive
setInterval(() => {}, 1 << 30);
