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
//   node --env-file=.env scripts/alerts-drain.mjs            # dry run (default)
//   node --env-file=.env scripts/alerts-drain.mjs --send     # actually send
//   node --env-file=.env scripts/alerts-drain.mjs --send --id 01K...   # one doc
//
// Dry-run by default because --send messages REAL customers: it lists exactly
// who would get what, and sends nothing. Delivery is stamped on the doc at
// checkGo.alert (mode 'live' + providerMessageId), which is also the dedupe:
// a doc already stamped 'live' is never sent twice.
import { connect, close, collections, buildCheckGoAlert, createWhatsAppClient, whatsappConfigFromEnv } from '../packages/core/dist/index.js';

const SEND = process.argv.includes('--send');
const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5)
  ?? (process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : undefined);

// Two caps, both against the same failure mode: a forgotten backlog turning
// into a blast the moment someone runs --send. Old docs are stale news to the
// customer AND a spam signal to WhatsApp — an unofficial-API number that
// suddenly fires hundreds of messages is how numbers get banned.
const MAX_PER_RUN = 25;
const MAX_AGE_DAYS = 7;

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');

const client = createWhatsAppClient(whatsappConfigFromEnv());
const status = await client.status();
console.log(`provider=${client.provider} status=${JSON.stringify(status)}`);
if (SEND && status.mode !== 'live') {
  // In preview mode "sending" would only mint wa.me links the intake already
  // stamps — running the drainer like that is a no-op wearing a success face.
  console.error('gateway is NOT live — connect it first (WAHA: docker compose up -d waha, then scan the QR). Nothing sent.');
  await close();
  process.exit(1);
}

const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString();
const q = onlyId
  ? { _id: onlyId }
  : {
      docType: 'CHECK_AND_GO',
      state: { $nin: ['voided', 'superseded'] },
      createdAt: { $gte: since },
      'checkGo.alert.mode': { $ne: 'live' }, // absent, manual, failed → eligible
    };
const docs = await collections.spk().find(q).sort({ createdAt: 1 }).limit(MAX_PER_RUN + 1).toArray();
const overflow = docs.length > MAX_PER_RUN;
const batch = docs.slice(0, MAX_PER_RUN);
console.log(`${batch.length} doc(s) eligible${overflow ? ` — MORE THAN ${MAX_PER_RUN}, capped; run again for the rest` : ''}\n`);

let sent = 0;
let failedCount = 0;
for (const doc of batch) {
  const label = `${doc._id} ${doc.vehicle?.noPolisi?.display ?? '?'} ${doc.branchCode}`;
  let alert;
  try {
    alert = buildCheckGoAlert(doc);
  } catch (e) {
    // Unusable number or no Check & Go data — a fact about the doc, stamped so
    // the board can show it, never retried by this loop.
    console.error(`  SKIP ${label} — ${e.message}`);
    if (SEND) await stamp(doc._id, { mode: 'failed', error: String(e.message).slice(0, 300) });
    failedCount += 1;
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
  } catch (e) {
    // TransientError here means the gateway died mid-run: stop, do not stamp —
    // the doc stays eligible and the next run picks it up.
    if (e?.name === 'TransientError') {
      console.error(`  gateway failed mid-run (${e.message}) — stopping; remaining docs stay queued`);
      break;
    }
    console.error(`  FAIL ${label} — ${e.message}`);
    await stamp(doc._id, { mode: 'failed', error: String(e.message).slice(0, 300) });
    failedCount += 1;
  }
}

async function stamp(spkId, alert) {
  await collections.spk()
    .updateOne({ _id: spkId }, { $set: { 'checkGo.alert': { ...alert, at: new Date().toISOString() } } })
    .catch(() => undefined);
}

console.log(`\n${SEND ? `sent ${sent}, failed ${failedCount}` : 'dry run — nothing sent. Re-run with --send.'}`);
await close();
process.exit(0);
