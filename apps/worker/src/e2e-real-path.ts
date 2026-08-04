import { connect, close, collections, enqueueFlowJob, flowJobs } from '@spk/core';
import { config } from './config.js';

/**
 * Stage the SAME work the live site produces, so the real cron entrypoints
 * (flow-once, push-once) can be run against it unchanged:
 *
 *   --stage=register  enqueue the /customers corporate registration flow job
 *   --stage=spk       capture the SPK the form would create, queued for push
 *   --stage=report    print the outcome of both
 *
 * Params mirror apps/web/app/customers/page.tsx buildPayload() exactly.
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const TAG = (arg('tag') ?? 'W3').toUpperCase();
const BRANCH = arg('branch') ?? 'NWL-BKS';
const ADVISOR = arg('advisor') ?? 'DEVI FITRIANI';
const COMPANY = `PT NAWILIS UJI ${TAG}`;
const RETAIL_NAMA = `DRIVER CORP ${TAG}`;
const digits = TAG.split('').map((c) => c.charCodeAt(0) % 10).join('').padEnd(5, '7').slice(0, 5);
const PHONE = `+62812${digits}${digits.slice(0, 3)}`;
const PLATE = `B${digits.slice(0, 4)}WHL`;
const ALAMAT = `JL UJI CORPORATE NO ${TAG}, JAKARTA`;

async function main(): Promise<void> {
  const stage = arg('stage') ?? 'report';
  await connect(config.mongoUri, config.mongoDb);

  if (stage === 'register') {
    const job = await enqueueFlowJob(
      '',
      'register_customer_wholesale',
      {
        companyName: COMPANY,
        picName: `PIC ${TAG}`,
        npwp: '01.234.567.8-901.000',
        alamat: ALAMAT,
        advisorName: ADVISOR,
        branchCode: BRANCH,
        retail: { nama: RETAIL_NAMA, phone: PHONE, alamat: ALAMAT, branchCode: BRANCH },
      },
      'e2e-real-path',
    );
    console.log(`register: job ${job._id} queued (${COMPANY} / ${RETAIL_NAMA} ${PHONE})`);
  }

  if (stage === 'spk') {
    const { buildSpkDoc, loadMirror, resolveSkus, assignMechanic } = await import('@spk/core');
    const mirror = await loadMirror(BRANCH);
    let doc = buildSpkDoc({
      uploadId: `e2e-real-${TAG}-${Date.now()}`,
      docType: 'SPK_NAWILIS',
      branchCode: BRANCH,
      captureMode: 'typed',
      operatorUserId: 'e2e',
      operatorPinVerified: true,
      deviceBindingVerified: true,
      spkNumber: `E2E-${TAG}`,
      qrPayload: null,
      capturedAt: new Date().toISOString(),
      customer: { nama: RETAIL_NAMA, wa: PHONE, alamat: ALAMAT, kontakLain: null, turbolyCustomerId: null },
      vehicle: { noPolisi: PLATE, merk: 'Toyota', tipe: 'Avanza', tahun: 2020, warna: 'Silver', km: '25000', createMakeConfirmed: false },
      complaint: `Servis rutin armada ${COMPANY}`,
      jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
      conditionChecks: [],
      rekomendasiService: null,
      estimasiMinutes: 60,
      serviceAdvisorName: ADVISOR,
      salespersonName: ADVISOR,
      signatures: {
        menyerahkanPresent: true,
        menyerahkanInkDensity: 40,
        menyerahkanNamaJelas: `PIC ${TAG}`,
        menerimaPresent: true,
        menerimaNamaJelas: ADVISOR,
      },
      attachments: [],
    } as never);
    doc = resolveSkus(doc, mirror.skuFor);
    doc.state = 'awaiting_assignment';
    await collections.spk().insertOne(doc);
    await assignMechanic(doc._id, { mechanicCode: 'E2E', by: 'e2e', via: 'console' });
    console.log(`spk: ${doc._id} queued (${RETAIL_NAMA} ${PLATE})`);
  }

  if (stage === 'report') {
    const jobs = await flowJobs().find({ 'params.companyName': COMPANY }).sort({ createdAt: 1 }).toArray();
    for (const j of jobs) {
      console.log(`job ${j._id} ${j.action} state=${j.state} attempts=${j.attempts}`);
      if (j.result) console.log(`  result: ${JSON.stringify(j.result)}`);
      if (j.error) console.log(`  error : ${j.error}`);
    }
    const docs = await collections.spk().find({ 'customer.nama': RETAIL_NAMA }).toArray();
    for (const d of docs) {
      console.log(`spk ${d._id} state=${d.state} SO=${d.turboly.serviceOrderNo ?? '-'} ${d.turboly.serviceOrderUrl ?? ''}`);
      if (d.push.lastError) console.log(`  error : ${d.push.lastError}`);
    }
  }

  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
