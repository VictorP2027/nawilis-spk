import { connect, close, collections, buildSpkDoc, loadMirror, resolveSkus } from '@spk/core';
import { buildTurbolyPayload, planFromNowWib, createServiceOrderHttp } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * Time a REAL Service Order created over HTTP for a customer that already
 * exists, and print what actually landed — the lines and the money, not just
 * the 302. A blank-line or zero-price order is the failure this path is most
 * likely to produce, and a redirect alone would hide it.
 *
 *   node --env-file=.env --import tsx apps/worker/src/time-http-order.ts "DRIVER CORP W7" B7577WHL
 */
const NAMA = process.argv[2] ?? 'DRIVER CORP W7';
const PLATE = process.argv[3] ?? 'B7577WHL';
const BRANCH = 'NWL-BKS';
const ADVISOR = 'DEVI FITRIANI';

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const mirror = await loadMirror(BRANCH);
  if (!mirror.store) throw new Error(`store ${BRANCH} missing from mirror`);

  let doc = buildSpkDoc({
    uploadId: `http-order-${Date.now()}`,
    docType: 'SPK_NAWILIS',
    branchCode: BRANCH,
    captureMode: 'typed',
    operatorUserId: 'e2e',
    operatorPinVerified: true,
    deviceBindingVerified: true,
    spkNumber: 'HTTP-ORDER',
    qrPayload: null,
    capturedAt: new Date().toISOString(),
    customer: { nama: NAMA, wa: null, alamat: null, kontakLain: null, turbolyCustomerId: null },
    vehicle: { noPolisi: PLATE, merk: 'Toyota', tipe: 'Avanza', tahun: 2020, warna: 'Silver', km: '26000', createMakeConfirmed: false },
    complaint: 'Uji jalur HTTP untuk Service Order',
    jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
    conditionChecks: [],
    rekomendasiService: null,
    estimasiMinutes: 60,
    serviceAdvisorName: ADVISOR,
    salespersonName: ADVISOR,
    signatures: { menyerahkanPresent: true, menyerahkanInkDensity: 40, menyerahkanNamaJelas: NAMA, menerimaPresent: true, menerimaNamaJelas: ADVISOR },
    attachments: [],
  } as never);
  doc = resolveSkus(doc, mirror.skuFor);
  doc.state = 'awaiting_assignment';
  await collections.spk().insertOne(doc);

  const person = mirror.advisorByName.get(ADVISOR) ?? { _id: 'x', mechanicCode: 'x', name: ADVISOR, storeCode: null, role: 'advisor', syncedAt: '' };
  const plan = planFromNowWib(30);
  const payload = buildTurbolyPayload({
    doc,
    store: mirror.store,
    serviceProducts: mirror.serviceProducts,
    serviceAdvisor: person,
    salesperson: person,
    planServiceDate: plan.date,
    planServiceTime: plan.time,
  });

  const t = Date.now();
  const r = await createServiceOrderHttp(payload, {
    baseUrl: config.turbolyBaseUrl,
    username: process.env.TURBOLY_USERNAME,
    password: process.env.TURBOLY_PASSWORD,
  });
  console.log(`\nORDER ${r.serviceOrderNo ?? '(no number)'}  ${((Date.now() - t) / 1000).toFixed(2)}s`);
  console.log(`  ${r.serviceOrderUrl}`);
  if (r.warnings?.length) for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  console.log(`  spkId ${doc._id}`);
  await close();
  process.exit(0);
}
main().catch(async (e) => {
  console.error('GAGAL:', (e as Error).name, '-', (e as Error).message ?? e);
  await close().catch(() => {});
  process.exit(1);
});
