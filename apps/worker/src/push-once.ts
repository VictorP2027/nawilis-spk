import { connect, close } from '@spk/core';
import { BranchSinks } from './sessions.js';
import { pushQueued } from './pushRunner.js';
import { config } from './config.js';

/**
 * Redis-free ONE-SHOT push — for testing the Turboly auto-feed and for
 * scheduled/cron runs. Pushes every `queued` SPK (or a single --id=<spkId>)
 * into Turboly, then verifies. Shares its logic with the always-on `push-loop`
 * via pushRunner.ts, so both behave identically.
 *
 *   npm run push:once            # push all queued
 *   npm run push:once -- --id=01K...   # push just one
 */
async function main(): Promise<void> {
  const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  await connect(config.mongoUri, config.mongoDb);
  const branchSinks = new BranchSinks();

  console.log(`push-once: mode=${config.pushMode} base=${config.turbolyBaseUrl}`);
  const r = await pushQueued(branchSinks, { workerId: 'push-once', onlyId, log: (m) => console.log(m) });
  console.log(`push-once: ${r.candidates} candidate(s) — ${r.confirmed} confirmed, ${r.pushed - r.confirmed} pushed-unverified, ${r.failed} failed`);

  await branchSinks.dispose();
  await close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
