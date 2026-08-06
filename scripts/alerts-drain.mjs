// Check & Go WhatsApp drainer — the WAHA path's other half.
//
// The web app runs on Vercel, and a serverless function cannot reach a WAHA
// container sitting on a laptop or a shop PC. So the send is decoupled from the
// intake: /api/checkgo stores the doc (stamping only a manual wa.me link, or
// nothing when CHECKGO_ALERT_ENABLED is off), and THIS script — run next to
// the gateway, where 127.0.0.1:3000 means something — finds every Check & Go
// whose customer has not been messaged and sends through @spk/core's WhatsApp
// client. Same architecture as the original nawilis-check-and-go-whatsapp
// server: gateway and sender live together, the database is the queue.
//
//   docker compose up -d waha           # once; pair the sender phone by QR
//   node --env-file=.env scripts/alerts-drain.mjs                  # dry run
//   node --env-file=.env scripts/alerts-drain.mjs --send           # send once
//   node --env-file=.env scripts/alerts-drain.mjs --send --watch   # keep sending
//   node --env-file=.env scripts/alerts-drain.mjs --send --id 01K… # one doc
//
// --watch[=seconds] (default 30) keeps the loop alive so a click on the flow
// board's Kirim WA button turns into a delivered message within a tick —
// while the car is still on the lift. Only docs stamped 'requested' by that
// button are ever sent; a new intake on its own goes nowhere. ops/launchd/
// has the plist that keeps this running on a Mac across reboots.
//
// Dry-run by default because --send messages REAL customers: it lists exactly
// who would get what, and sends nothing. Delivery is stamped on the doc at
// checkGo.alert (mode 'live' + providerMessageId), which is also the dedupe:
// a doc already stamped 'live' is never sent twice.
import { connect, close, collections, buildCheckGoAlert, createWhatsAppClient, whatsappConfigFromEnv } from '../packages/core/dist/index.js';

const SEND = process.argv.includes('--send');
const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5)
  ?? (process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : undefined);
const watchArg = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SECS = watchArg ? Math.max(10, Number(watchArg.split('=')[1] ?? 30) || 30) : null;

// Caps, all against the same failure mode: an unofficial-API number that
// suddenly fires a burst of messages is how numbers get banned, and old docs
// are stale news to the customer anyway. The pause between sends keeps even a
// full batch looking like a human typing, not a cannon.
const MAX_PER_RUN = 25;
const MAX_AGE_DAYS = 7;
const PAUSE_BETWEEN_SENDS_MS = 3_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In watch mode the connect itself must survive a bad network: this runs on a
// laptop whose DNS provably goes away for an hour at a time, and a watcher
// that dies at startup because the first lookup timed out protects nobody.
// One-shot runs still fail fast — a human is watching those.
const WATCHING = process.argv.some((a) => a === '--watch' || a.startsWith('--watch='));
for (;;) {
  try {
    await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
    break;
  } catch (e) {
    if (!WATCHING) throw e;
    console.error(`[${new Date().toISOString()}] Mongo connect failed (${String(e.message).slice(0, 70)}) — retrying in 30s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
const client = createWhatsAppClient(whatsappConfigFromEnv());

async function stamp(spkId, alert) {
  await collections.spk()
    .updateOne({ _id: spkId }, { $set: { 'checkGo.alert': { ...alert, at: new Date().toISOString() } } })
    .catch(() => undefined);
}

/**
 * Mirror the gateway's state into Mongo so the WEB can show it. Vercel cannot
 * reach this machine; Mongo is the bridge. When the session needs pairing the
 * actual QR image rides along — anyone can then pair the sender phone from
 * /admin in a browser, without touching Docker or this computer.
 */
async function publishGatewayStatus(status) {
  try {
    const doc = {
      session: process.env.WAHA_SESSION || 'default',
      status,
      updatedAt: new Date().toISOString(),
      qrDataUrl: null,
    };
    if (String(status.sessionStatus || '').toUpperCase() === 'SCAN_QR_CODE') {
      const base = (process.env.WAHA_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
      const r = await fetch(`${base}/api/${doc.session}/auth/qr`, {
        headers: { 'X-Api-Key': process.env.WAHA_API_KEY || '', accept: 'image/png' },
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        doc.qrDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      }
    }
    const { getDb } = await import('../packages/core/dist/index.js');
    await getDb().collection('wa_gateway').updateOne({ _id: 'status' }, { $set: doc }, { upsert: true });
  } catch { /* status mirroring must never break sending */ }
}

/** One pass over the queue. Returns false when the gateway is unusable. */
async function drainOnce() {
  const status = await client.status();
  await publishGatewayStatus(status);
  if (SEND && status.mode !== 'live') {
    // In preview mode "sending" would only mint wa.me links the intake already
    // stamps — a no-op wearing a success face. In watch mode this is routine
    // (gateway restarting, session dropped) and the next tick retries.
    console.error(`[${new Date().toISOString()}] gateway NOT live (${JSON.stringify(status)}) — nothing sent`);
    return false;
  }

  const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString();
  // --id keeps the 'live' dedupe too: without it, running the same command
  // twice double-messaged the customer — the one thing the stamp exists to
  // prevent. Re-sending a delivered doc is --force, said out loud.
  const q = onlyId
    ? (process.argv.includes('--force') ? { _id: onlyId } : { _id: onlyId, 'checkGo.alert.mode': { $ne: 'live' } })
    : {
        docType: 'CHECK_AND_GO',
        state: { $nin: ['voided', 'superseded'] },
        createdAt: { $gte: since },
        // ONLY docs a human explicitly approved. The flow board's Kirim WA
        // button (POST /api/checkgo/:id/alert) writes this stamp after showing
        // staff the full message and profile — a new intake on its own is NOT
        // eligible, so the watcher can run forever without messaging anyone
        // nobody signed off on. (An earlier version sent every unstamped
        // intake automatically; that design lasted one day.)
        'checkGo.alert.mode': 'requested',
      };
  const docs = await collections.spk().find(q).sort({ createdAt: 1 }).limit(MAX_PER_RUN + 1).toArray();
  const overflow = docs.length > MAX_PER_RUN;
  const batch = docs.slice(0, MAX_PER_RUN);
  if (batch.length || !WATCH_SECS) {
    console.log(`[${new Date().toISOString()}] ${batch.length} doc(s) eligible${overflow ? ` — capped at ${MAX_PER_RUN}, rest next run` : ''}`);
  }

  let sent = 0;
  for (const doc of batch) {
    const label = `${doc._id} ${doc.vehicle?.noPolisi?.display ?? '?'} ${doc.branchCode}`;
    let alert;
    try {
      alert = buildCheckGoAlert(doc);
    } catch (e) {
      console.error(`  SKIP ${label} — ${e.message}`);
      if (SEND) await stamp(doc._id, { mode: 'failed', error: String(e.message).slice(0, 300) });
      continue;
    }
    if (!SEND) {
      console.log(`  would send → ${alert.to}  (${label})`);
      continue;
    }
    try {
      const res = await client.sendReport(alert);
      await stamp(doc._id, {
        mode: res.mode, provider: client.provider, to: alert.to,
        providerMessageId: res.providerMessageId ?? null,
        whatsappUrl: res.whatsappUrl ?? null,
      });
      sent += 1;
      console.log(`  sent → ${alert.to}  id=${res.providerMessageId ?? '-'}  (${label})`);
      await sleep(PAUSE_BETWEEN_SENDS_MS);
    } catch (e) {
      // TransientError = the gateway died mid-run: stop this pass without
      // stamping, so the doc stays eligible and the next tick picks it up.
      if (e?.name === 'TransientError') {
        console.error(`  gateway failed mid-run (${e.message}) — stopping pass; remainder stays queued`);
        return false;
      }
      console.error(`  FAIL ${label} — ${e.message}`);
      await stamp(doc._id, { mode: 'failed', error: String(e.message).slice(0, 300) });
    }
  }
  if (SEND && (batch.length || !WATCH_SECS)) console.log(`  pass done: sent ${sent}/${batch.length}`);
  return true;
}

console.log(`provider=${client.provider} mode=${SEND ? 'SEND' : 'dry-run'}${WATCH_SECS ? ` watch=${WATCH_SECS}s` : ''}`);
if (WATCH_SECS) {
  // The loop must outlive a flaky gateway — that is its entire value. Only an
  // operator (Ctrl+C / launchd unload) stops it.
  let running = true;
  process.on('SIGINT', () => { running = false; console.log('\nstopping after this pass…'); });
  process.on('SIGTERM', () => { running = false; });
  while (running) {
    try {
      await drainOnce();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] pass crashed (${e.message}) — retrying next tick`);
    }
    if (!running) break;
    await sleep(WATCH_SECS * 1000);
  }
} else {
  const ok = await drainOnce();
  if (!SEND) console.log('dry run — nothing sent. Re-run with --send.');
  if (!ok && SEND) process.exitCode = 1;
}
await close();
process.exit(process.exitCode ?? 0);
