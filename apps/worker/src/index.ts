import { connect, ensureIndexes, close } from '@spk/core';
import { config } from './config.js';
import { makeWorker, PUSH_QUEUE, VERIFY_QUEUE, type PushJob, type VerifyJob } from './queue.js';
import { Poller } from './poller.js';
import { PushWorker } from './pushWorker.js';
import { Verifier } from './verifier.js';
import { BranchSinks } from './sessions.js';
import { AuthBreaker, StructuralBreaker } from './breaker.js';
import { DegradationController } from './degradation.js';
import { reconcile, type HarvestedSo } from './reconciler.js';
import { fireAlert } from './alerts.js';

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  await ensureIndexes();

  const branchSinks = new BranchSinks();
  const authBreaker = new AuthBreaker();
  const structuralBreaker = new StructuralBreaker();
  const degradation = new DegradationController();
  await degradation.load();

  const pushWorker = new PushWorker(branchSinks, authBreaker, structuralBreaker, degradation);
  const verifier = new Verifier(branchSinks);
  const poller = new Poller(structuralBreaker, degradation);

  const pw = makeWorker<PushJob>(PUSH_QUEUE, (d) => pushWorker.process(d), config.maxBrowserWorkers);
  const vw = makeWorker<VerifyJob>(VERIFY_QUEUE, (d) => verifier.process(d), Math.max(1, Math.floor(config.maxBrowserWorkers / 2)));

  poller.start();
  console.log(`[worker] up. mode=${config.pushMode} base=${config.turbolyBaseUrl} maxWorkers=${config.maxBrowserWorkers}`);
  if (config.pushMode === 'manual') {
    console.log('[worker] PUSH_MODE=manual — nothing is pushed to Turboly. Capture the selector map and switch to rpa when ready.');
  }

  // Structural canary loop — read-only form probe every CANARY_INTERVAL_MS.
  const canaryTimer = setInterval(() => void runCanary(branchSinks, structuralBreaker, degradation).catch((e) => console.error('canary error', e)), config.canaryIntervalMs);

  // Reconciler — hourly harvest + set-diff (a full daily run at 06:00 WIB is
  // scheduled by cron in prod; here we run it hourly for continuous safety).
  const reconTimer = setInterval(() => void runReconcile(branchSinks).catch((e) => console.error('recon error', e)), 3600_000);

  const shutdown = async () => {
    console.log('[worker] shutting down…');
    clearInterval(canaryTimer);
    clearInterval(reconTimer);
    poller.stop();
    await pw.close();
    await vw.close();
    await branchSinks.dispose();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runCanary(branchSinks: BranchSinks, breaker: StructuralBreaker, degradation: DegradationController): Promise<void> {
  if (config.pushMode !== 'rpa') return;
  const branches = branchSinks.branches();
  if (branches.length === 0) return;
  // Probe one active branch's form (cheap, read-only).
  const branch = branches[0]!;
  const result = await branchSinks.withSink(branch, (sink) => sink.canary());
  await breaker.recordCanary(result.ok);
  await degradation.recordCanary(result.ok, result.controlHash);
  if (!result.ok) {
    await fireAlert({ level: 'page', code: 'CANARY_FAIL', branchCode: branch, message: result.detail ?? 'canary failed' });
    await degradation.descendTo(2, `canary failed: ${result.detail ?? ''}`);
  }
}

async function runReconcile(branchSinks: BranchSinks): Promise<void> {
  // Harvest strategy depends on mode. For RPA we scrape the SO list over 72h;
  // that scraper lives with the sink. Here we provide a thin harvest closure.
  const harvest = async (): Promise<HarvestedSo[]> => {
    // Best-effort: read recent recon-relevant SOs. In manual/api mode this is a
    // no-op or an API call; the RPA list-harvest is implemented in a follow-up
    // (verifyByToken covers per-record; this covers the safety-net sweep).
    void branchSinks;
    return [];
  };
  await reconcile(harvest);
}

main().catch(async (e) => {
  console.error('[worker] fatal', e);
  await close().catch(() => {});
  process.exit(1);
});
