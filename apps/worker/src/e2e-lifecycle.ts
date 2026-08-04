import { connect, close, collections, enqueueFlowJob, flowJobs, effectiveFlow } from '@spk/core';
import { config } from './config.js';
import { spawn } from 'node:child_process';

/**
 * ONE wholesale customer, all the way: the corporate registration and Service
 * Order are expected to be done already (e2e-wholesale --tag=<TAG>); this drives
 * the rest of the Turboly lifecycle — Work Order, start, complete, QC, Invoice —
 * one step at a time, draining the real flow runner between each so the run is
 * exactly what the board would produce.
 *
 *   node --import tsx apps/worker/src/e2e-lifecycle.ts --tag=L1 --mechanic="AHMAD JAYNUDIN"
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const TAG = (arg('tag') ?? 'L1').toUpperCase();
const MECHANIC = arg('mechanic') ?? 'AHMAD JAYNUDIN';
const RETAIL_NAMA = `DRIVER CORP ${TAG}`;

const drain = (): Promise<void> =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', './scripts/dns-public.mjs', '--import', 'tsx', 'apps/worker/src/flow-once.ts'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { out += String(d); });
    p.on('close', () => {
      for (const l of out.split('\n')) if (/^flow-once: (ok|FAIL|\d)/.test(l)) console.log(`      ${l.trim().slice(0, 200)}`);
      resolve();
    });
  });

async function step(spkId: string, action: string, params: Record<string, unknown>): Promise<boolean> {
  const job = await enqueueFlowJob(spkId, action as never, params, 'e2e-lifecycle');
  process.stdout.write(`  → ${action} … `);
  for (let i = 0; i < 3; i++) {
    await drain();
    const j = await flowJobs().findOne({ _id: job._id });
    if (j?.state === 'done') { console.log(`✓ ${JSON.stringify(j.result ?? {}).slice(0, 150)}`); return true; }
    if (j?.state === 'failed') { console.log(`✗ ${(j.error ?? '').slice(0, 220)}`); return false; }
    console.log(`   (percobaan ${i + 1}: ${j?.state ?? '?'} — ${(j?.error ?? '').slice(0, 120)})`);
  }
  return false;
}

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const doc = await collections.spk().findOne({ 'customer.nama': RETAIL_NAMA });
  if (!doc) throw new Error(`SPK untuk ${RETAIL_NAMA} tidak ada — jalankan e2e-wholesale --tag=${TAG} dulu`);
  console.log(`SPK ${doc._id} state=${doc.state} SO=${doc.turboly.serviceOrderNo ?? '-'}`);
  if (!doc.turboly.serviceOrderUrl) throw new Error('Service Order belum ada — push dulu');

  const steps: Array<[string, Record<string, unknown>]> = [
    ['create_wo', { assigneeName: MECHANIC }],
    ['start_wo', {}],
    ['complete_wo', { waktuMinutes: 45, problem: 'ban depan aus tidak rata', actionTaken: 'spooring dan balancing' }],
    ['qc_ok', { nextOdometer: 30000, nextServiceDateISO: '2026-11-05', recommendations: 'cek tekanan ban tiap bulan' }],
    ['create_invoice', {}],
    ['complete_invoice', { method: 'Cash', amount: 350000 }],
  ];

  for (const [action, params] of steps) {
    const ok = await step(doc._id, action, params);
    if (!ok) {
      const d = await collections.spk().findOne({ _id: doc._id });
      console.log(`\n✗ BERHENTI di ${action}. Flow sekarang: ${JSON.stringify(effectiveFlow(d as never))}`);
      await close();
      process.exit(1);
    }
  }

  const final = await collections.spk().findOne({ _id: doc._id });
  const f = effectiveFlow(final as never);
  console.log('\n════════════════════════════════════════');
  console.log('  ✓ SIKLUS PENUH SELESAI');
  console.log(`  SO      : ${final?.turboly.serviceOrderNo} ${final?.turboly.serviceOrderUrl}`);
  console.log(`  WO      : ${f?.workOrderNo ?? '-'} ${f?.workOrderUrl ?? ''}`);
  console.log(`  Invoice : ${f?.invoiceNo ?? '-'} ${f?.invoiceUrl ?? ''}`);
  console.log(`  Bayar   : ${f?.payment?.method ?? '-'} ${f?.payment?.amount ?? '-'}`);
  console.log('════════════════════════════════════════');
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error('GAGAL:', (e as Error).message ?? e); await close().catch(() => {}); process.exit(1); });
