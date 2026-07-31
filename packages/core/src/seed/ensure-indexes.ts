import { connect, ensureIndexes, close } from '../mongo.js';

/** Create all indexes (idempotent). Run once per environment + after schema changes. */
async function main(): Promise<void> {
  await connect();
  await ensureIndexes();
  console.log('✓ indexes ensured');
  await close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
