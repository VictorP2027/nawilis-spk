import { connect, ensureIndexes, close, collections } from '../mongo.js';
import { REF_BRANCHES, REF_SERVICES } from '../refdata.js';

/**
 * Seed baseline state: ensure indexes and initialise the degradation singleton
 * at rung 0. Reference data (branches/services) lives in code, not the DB, so we
 * only report it here for sanity.
 */
async function main(): Promise<void> {
  await connect();
  await ensureIndexes();

  await collections.degradation().updateOne(
    { _id: 'degradation' },
    {
      $setOnInsert: {
        _id: 'degradation',
        rung: 0,
        since: new Date().toISOString(),
        reason: 'seed',
        lastCanaryHash: null,
        lastCanaryOkAt: null,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );

  console.log(`✓ ${REF_BRANCHES.length} branches, ${REF_SERVICES.length} services in code refdata`);
  console.log('✓ degradation singleton at rung 0');
  console.log('Next: import Turboly master data →  npm run seed:turboly -- ./turboly-export.json');
  await close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
