import { connect, close, collections } from '@spk/core';
import { BranchSinks } from './sessions.js';
import { pushQueued, type RunResult } from './pushRunner.js';
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

/** push.yml gives the job 60 minutes — leave 10 for the run to end by itself. */
const TIME_BUDGET_MS = 50 * 60_000;

/**
 * How long an idle-but-warm runner waits for one more SPK before exiting.
 *
 * Getting a runner is the expensive part: checkout + npm ci + Playwright +
 * build is 60-90s before this process even exists, and push/flow/sync share the
 * `turboly-push` concurrency group, so an SPK assigned two seconds after the
 * last queue read pays that whole minute again — its dispatch has to wait for
 * this run to end, get past the group, and cold-start a second runner. Waiting
 * here instead costs seconds and reuses the logged-in session.
 *
 * Deliberately short, and only after real work: an empty cron pass must exit
 * immediately, and every second held is a second flow.yml (customer
 * registration — the latency the owner actually complains about) waits for the
 * shared concurrency group.
 */
const GRACE_MS = Number.isFinite(Number(process.env.PUSH_DRAIN_GRACE_MS)) ? Number(process.env.PUSH_DRAIN_GRACE_MS) : 12_000;
const GRACE_POLL_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  const startedAt = Date.now();
  await connect(config.mongoUri, config.mongoDb);
  const branchSinks = new BranchSinks();
  const log = (m: string) => console.log(m);
  const left = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  console.log(`push-once: mode=${config.pushMode} base=${config.turbolyBaseUrl}`);
  const total: RunResult = { candidates: 0, pushed: 0, confirmed: 0, failed: 0 };
  const add = (r: RunResult) => {
    total.candidates += r.candidates;
    total.pushed += r.pushed;
    total.confirmed += r.confirmed;
    total.failed += r.failed;
  };

  add(await pushQueued(branchSinks, { workerId: 'push-once', onlyId, budgetMs: left(), log }));

  if (!onlyId && total.candidates > 0) {
    // Probe with a count, not a full pass: pushQueued re-runs the retry/orphan
    // scans on entry and those are pointless every 3s (transient retries are
    // 60s out). This is one indexed read against ix_push_queue.
    let until = Date.now() + GRACE_MS;
    while (Date.now() < until && left() > 0) {
      await sleep(GRACE_POLL_MS);
      if ((await collections.spk().countDocuments({ state: 'queued' }, { limit: 1 })) === 0) continue;
      const r = await pushQueued(branchSinks, { workerId: 'push-once', budgetMs: left(), log });
      if (r.candidates > 0) {
        add(r);
        until = Date.now() + GRACE_MS; // work is still arriving — keep the warm session
      }
    }
  }

  console.log(`push-once: ${total.candidates} candidate(s) — ${total.confirmed} confirmed, ${total.pushed - total.confirmed} pushed-unverified, ${total.failed} failed`);

  /**
   * An auth failure ends the run RED; every other outcome stays green.
   *
   * Transient failures are the normal weather here — a slow Turboly search, a
   * kicked session — and they retry themselves, so failing the job on those would
   * turn the signal into noise. An auth failure is different: it is the one class
   * that can mean a human has to act, and until now it was invisible. The job
   * exited 0 whatever happened, so `if: failure()` never once fired and the
   * screenshot upload guarded by it has never run. That is why a start-of-day
   * failure leaves no evidence to look at the next morning.
   *
   * Read from the documents rather than threaded up through pushRunner: the class
   * is decided in pushWorker.handleFailure and written there, and one indexed read
   * is cheaper than a new field on every layer in between.
   */
  const authFailures = await collections.spk().countDocuments({
    state: 'failed',
    'push.failureClass': 'auth',
    'push.lastError': { $exists: true },
    updatedAt: { $gte: new Date(startedAt).toISOString() },
  });
  if (authFailures > 0) {
    console.error(`push-once: ${authFailures} document(s) failed on AUTH this run — re-run with debug_screenshots to capture what Turboly returned.`);
  }

  await branchSinks.dispose();
  await close();
  process.exit(authFailures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
