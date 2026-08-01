import { connect, close } from '@spk/core';
import { BranchSinks } from './sessions.js';
import { pushQueued } from './pushRunner.js';
import { config, inPushWindow } from './config.js';

/**
 * ALWAYS-ON, Redis-free push loop — the production runtime for the Oracle Free VM.
 *
 * Polls Atlas every POLL_INTERVAL_MS for `queued` SPKs and pushes+verifies each
 * (the exact path proven live). No BullMQ/Redis — one process, one browser
 * session per branch, serial. pm2 keeps it alive and restarts on crash/boot.
 *
 * Respects the WIB business-hours window (PUSH_WINDOW_START..END). Set
 * PUSH_WINDOW_START=00:00 and PUSH_WINDOW_END=23:59 to run 24/7.
 *
 *   node apps/worker/dist/push-loop.js
 */
let running = true;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const branchSinks = new BranchSinks();

  const shutdown = async () => {
    if (!running) return;
    running = false;
    console.log('[push-loop] shutting down…');
    await branchSinks.dispose().catch(() => {});
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[push-loop] up. mode=${config.pushMode} base=${config.turbolyBaseUrl} poll=${config.pollIntervalMs}ms window=${config.windowStart}-${config.windowEnd} WIB`);
  if (config.pushMode !== 'rpa') {
    console.log(`[push-loop] WARNING: PUSH_MODE=${config.pushMode} — nothing will be pushed. Set PUSH_MODE=rpa.`);
  }

  let idleAnnounced = false;
  while (running) {
    try {
      if (!inPushWindow()) {
        if (!idleAnnounced) { console.log('[push-loop] outside push window — idling'); idleAnnounced = true; }
        await sleep(config.pollIntervalMs);
        continue;
      }
      idleAnnounced = false;
      const r = await pushQueued(branchSinks, { workerId: 'push-loop', log: (m) => console.log(m) });
      if (r.candidates > 0) {
        console.log(`[push-loop] pass: ${r.candidates} candidate(s) — ${r.confirmed} confirmed, ${r.pushed - r.confirmed} pushed-unverified, ${r.failed} failed`);
      }
    } catch (e) {
      // Never let a single bad pass kill the loop; pm2 is the last resort.
      console.error(`[push-loop] pass error: ${(e as Error).message ?? e}`);
    }
    await sleep(config.pollIntervalMs);
  }
}
main().catch(async (e) => { console.error('[push-loop] fatal', e); await close().catch(() => {}); process.exit(1); });
