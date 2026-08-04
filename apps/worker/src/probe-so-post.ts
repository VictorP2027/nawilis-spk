import { connect, close, collections, buildSpkDoc, loadMirror, resolveSkus, assignMechanic } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { RpaSink } from '../../../packages/core/src/turboly/rpaSink.js';
import { buildTurbolyPayload, planFromNowWib } from '@spk/core/turboly';
import { writeFileSync } from 'node:fs';
import { config } from './config.js';

/**
 * Capture the REAL network POST the browser sends when it saves a Service
 * Order. A FormData snapshot of the DOM is only a simulation — if Turboly's JS
 * intercepts submit and adds the service lines itself, the snapshot misses them
 * and you wrongly conclude the lines are staged elsewhere. This reads the wire.
 */
const BRANCH = 'NWL-BKS';
const ADVISOR = 'DEVI FITRIANI';
const TAG = process.argv[2] ?? 'P1';

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const mirror = await loadMirror(BRANCH);
  if (!mirror.store) throw new Error('store missing');

  let doc = buildSpkDoc({
    uploadId: `probe-post-${TAG}-${Date.now()}`,
    docType: 'SPK_NAWILIS',
    branchCode: BRANCH,
    captureMode: 'typed',
    operatorUserId: 'probe',
    operatorPinVerified: true,
    deviceBindingVerified: true,
    spkNumber: `PROBE-${TAG}`,
    qrPayload: null,
    capturedAt: new Date().toISOString(),
    customer: { nama: 'DRIVER CORP W7', wa: '+6281275777757', alamat: null, kontakLain: null, turbolyCustomerId: null },
    vehicle: { noPolisi: 'B7577WHL', merk: 'Toyota', tipe: 'Avanza', tahun: 2020, warna: 'Silver', km: '27000', createMakeConfirmed: false },
    complaint: 'probe: capture the real POST',
    jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
    conditionChecks: [],
    rekomendasiService: null,
    estimasiMinutes: 60,
    serviceAdvisorName: ADVISOR,
    salespersonName: ADVISOR,
    signatures: { menyerahkanPresent: true, menyerahkanInkDensity: 40, menyerahkanNamaJelas: 'PROBE', menerimaPresent: true, menerimaNamaJelas: ADVISOR },
    attachments: [],
  } as never);
  doc = resolveSkus(doc, mirror.skuFor);
  doc.state = 'awaiting_assignment';
  await collections.spk().insertOne(doc);
  await assignMechanic(doc._id, { mechanicCode: 'PROBE', by: 'probe', via: 'console' });

  const session = new TurbolySession({
    baseUrl: config.turbolyBaseUrl,
    stateDir: config.turbolyStateDir,
    userAgentSuffix: config.userAgentSuffix,
    branchCode: BRANCH,
  });
  await session.start();
  await session.ensureLoggedIn();
  const page = session.page_();

  const captured: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const url = req.url();
    if (!/service_order|line_item|lookup/i.test(url)) return;
    const body = req.postData() ?? '(no body)';
    captured.push(`\n=== POST ${url}\n${body.slice(0, 4000)}`);
  });

  const person = mirror.advisorByName.get(ADVISOR) ?? { _id: 'x', mechanicCode: 'x', name: ADVISOR, storeCode: null, role: 'advisor', syncedAt: '' };
  const plan = planFromNowWib(30);
  const payload = buildTurbolyPayload({
    doc, store: mirror.store, serviceProducts: mirror.serviceProducts,
    serviceAdvisor: person, salesperson: person,
    planServiceDate: plan.date, planServiceTime: plan.time,
  });

  const sink = new RpaSink(session, { screenshotDir: config.screenshotDir });
  const res = await sink.pushServiceOrder(payload, {
    workerId: 'probe', epoch: 1, approve: false, leaseExpiresAt: Date.now() + 10 * 60_000,
  });
  console.log(`push ok=${res.ok} no=${res.serviceOrderNo ?? '-'} ${res.error ?? ''}`);

  writeFileSync('/tmp/so-posts.txt', captured.join('\n'));
  console.log(`\ncaptured ${captured.length} POST(s) → /tmp/so-posts.txt`);
  for (const c of captured) console.log(c.slice(0, 1500));

  await session.dispose().catch(() => {});
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
