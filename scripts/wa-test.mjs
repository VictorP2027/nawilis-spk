// One-off WhatsApp deliverability test.
//
//   node --env-file=.env scripts/wa-test.mjs            # render only, sends nothing
//   node --env-file=.env scripts/wa-test.mjs --send     # actually send
//   node --env-file=.env scripts/wa-test.mjs --send --to 14047034284
//
// It builds the message from a REAL Check & Go in Mongo and then redirects it
// to the test handset, so what arrives is byte-for-byte what a customer gets —
// a hand-written "test 123" would prove the gateway works and nothing about
// the thing we actually ship. Read-only: no document is written or stamped, so
// this never marks a real customer as already-notified.
import { connect, close, collections, buildCheckGoAlert, createWhatsAppClient, whatsappConfigFromEnv } from '../packages/core/dist/index.js';

const SEND = process.argv.includes('--send');
const TO = process.argv.find((a) => a.startsWith('--to='))?.slice(5)
  ?? (process.argv.includes('--to') ? process.argv[process.argv.indexOf('--to') + 1] : '14047034284');

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const doc = await collections.spk().findOne(
  { docType: 'CHECK_AND_GO', 'checkGo.report': { $ne: null } },
  { sort: { createdAt: -1 } },
);
if (!doc) { console.error('no Check & Go with a report in Mongo'); await close(); process.exit(1); }

const alert = buildCheckGoAlert(doc);
console.log(`source doc : ${doc._id}  (${doc.branchCode}, ${doc.checkGo.inspectionItems.length} baris)`);
console.log(`real customer: ${alert.to}   →  REDIRECTED TO: ${TO}`);
console.log('\n──────── message as the customer receives it ────────');
console.log(alert.text);
console.log('────────────────────────────────────────────────────\n');

const client = createWhatsAppClient(whatsappConfigFromEnv());
const st = await client.status();
console.log(`gateway: ${st.provider} · session ${st.session} · ${st.sessionStatus} · mode=${st.mode}${st.error ? ` · ${st.error}` : ''}`);

if (!SEND) { console.log('\nDRY RUN — nothing sent. Re-run with --send.'); await close(); process.exit(0); }
if (st.mode !== 'live') { console.error(`\nsession not live (${st.sessionStatus}) — not sending.`); await close(); process.exit(1); }

const res = await client.sendReport({ ...alert, to: TO });
console.log(`\nSENT → mode=${res.mode}  providerMessageId=${res.providerMessageId ?? '—'}`);
if (res.whatsappUrl) console.log(`manual fallback: ${res.whatsappUrl}`);
await close();
