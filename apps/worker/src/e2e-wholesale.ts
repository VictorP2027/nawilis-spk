import {
  connect, close, collections, buildSpkDoc, loadMirror, resolveSkus, assignMechanic,
} from '@spk/core';
import { TurbolySession, TurbolyFlowRpa } from '@spk/core/turboly';
import { BranchSinks } from './sessions.js';
import { pushQueued } from './pushRunner.js';
import { config } from './config.js';

/**
 * END-TO-END ACCEPTANCE RUN — the whole corporate path in one command:
 *
 *   1. register the WHOLESALE company (+ its linked retail customer)
 *   2. capture a filled SPK form for that customer and queue it
 *   3. push it to Turboly  → Service Order
 *   4. verify the Service Order is APPROVED (approve it if the push didn't)
 *
 * Every step is idempotent, so re-running after a fix resumes instead of
 * duplicating (company dedupe by name, customer dedupe by phone, SPK by _id).
 *
 *   node --import tsx apps/worker/src/e2e-wholesale.ts --tag=A1
 *
 * NOTE: Turboly allows ONE SESSION PER USER — disable push.yml/flow.yml while
 * this runs, and re-enable them straight after.
 */

const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const BRANCH = arg('branch') ?? 'NWL-BKS';
const TAG = (arg('tag') ?? String(Date.now()).slice(-5)).toUpperCase();
const ADVISOR = arg('advisor') ?? 'DEVI FITRIANI';
const SALES = arg('sales') ?? ADVISOR;

const COMPANY = arg('company') ?? `PT NAWILIS UJI ${TAG}`;
const PIC = arg('pic') ?? `PIC ${TAG}`;
const NPWP = arg('npwp') ?? '01.234.567.8-901.000';
const ALAMAT = arg('alamat') ?? `JL UJI CORPORATE NO ${TAG}, JAKARTA`;
const RETAIL_NAMA = arg('retail') ?? `DRIVER CORP ${TAG}`;
// Deterministic per tag so a re-run dedupes onto the same customer.
const digits = TAG.split('').map((c) => (c.charCodeAt(0) % 10)).join('').padEnd(5, '7').slice(0, 5);
const PHONE = arg('phone') ?? `+62812${digits}${digits.slice(0, 3)}`;
const PLATE = arg('plate') ?? `B${digits.slice(0, 4)}WHL`;

const log = (m: string) => console.log(`[e2e ${TAG}] ${m}`);
const fail = (m: string): never => {
  console.error(`\n✗ GAGAL: ${m}\n`);
  process.exit(1);
};

/** Retryable = someone else's Turboly login kicked us, or the page/network flaked. */
const retryable = (e: unknown): boolean =>
  /ter-kick|logged out|sign_in|sign in|maintenance|timeout|timed out|net::|ERR_|target closed/i.test(
    (e as Error)?.message ?? String(e),
  );

/**
 * Turboly allows ONE SESSION PER USER: the web app's customer lookup, a cron,
 * or a human in a browser can kick this run mid-form at any moment. That is
 * routine, not a failure — retry with a brand-new session (every step is
 * idempotent, so a retry resumes instead of duplicating).
 */
async function withRetry<T>(label: string, attempts: number, fn: (attempt: number) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      const msg = (e as Error).message ?? String(e);
      if (!retryable(e) || attempt === attempts) break;
      log(`   ↻ ${label} percobaan ${attempt} gagal (${msg.slice(0, 120)}) — ulangi dengan sesi baru`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw last;
}

async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  log(`branch=${BRANCH} base=${config.turbolyBaseUrl}`);
  log(`company="${COMPANY}" pic="${PIC}" retail="${RETAIL_NAMA}" phone=${PHONE} plate=${PLATE}`);

  const mirror = await loadMirror(BRANCH);
  if (!mirror.store) fail(`store ${BRANCH} tidak ada di mirror`);
  const storeTurbolyId = mirror.store?.turbolyStoreId ?? null;

  // ── 1. wholesale company + linked retail customer ───────────────────────
  const newRig = async (): Promise<{ session: TurbolySession; rpa: TurbolyFlowRpa }> => {
    const session = new TurbolySession({
      baseUrl: config.turbolyBaseUrl,
      stateDir: config.turbolyStateDir,
      userAgentSuffix: config.userAgentSuffix,
      branchCode: BRANCH,
    });
    await session.start();
    return { session, rpa: new TurbolyFlowRpa(session, { screenshotDir: config.screenshotDir }) };
  };

  let wholesale: Awaited<ReturnType<TurbolyFlowRpa['registerWholesaleCustomer']>>;
  try {
    log('1/4 daftar Customer Wholesale + retail terkait…');
    wholesale = await withRetry('registrasi wholesale', 5, async () => {
      const rig = await newRig();
      try {
        return await rig.rpa.registerWholesaleCustomer({
          companyName: COMPANY,
          picName: PIC,
          npwp: NPWP,
          alamat: ALAMAT,
          advisorName: SALES,
          retail: { nama: RETAIL_NAMA, phone: PHONE, alamat: ALAMAT, storeTurbolyId },
        });
      } finally {
        await rig.session.dispose().catch(() => {});
      }
    });
  } catch (e) {
    await close();
    return fail(`registrasi wholesale — ${(e as Error).message ?? e}`);
  }
  log(`   ✓ company id=${wholesale.companyId} url=${wholesale.companyUrl}${wholesale.note ? ` (${wholesale.note})` : ''}`);
  if (wholesale.retail) {
    log(`   ✓ retail  id=${wholesale.retail.customerId} url=${wholesale.retail.customerUrl}${wholesale.retail.note ? ` (${wholesale.retail.note})` : ''}`);
  } else {
    fail('retail customer tidak dibuat — SPK tidak bisa dipush atas nama perusahaan');
  }

  // ── 2. filled SPK form for that customer ────────────────────────────────
  const existing = await collections.spk().findOne({ 'customer.nama': RETAIL_NAMA, state: { $nin: ['voided', 'superseded'] } });
  let spkId: string;
  if (existing) {
    spkId = existing._id;
    log(`2/4 SPK sudah ada (${spkId}, state=${existing.state}) — dipakai ulang`);
  } else {
    const now = new Date().toISOString();
    let doc = buildSpkDoc({
      uploadId: `e2e-wholesale-${TAG}-${Date.now()}`,
      docType: 'SPK_NAWILIS',
      branchCode: BRANCH,
      captureMode: 'typed',
      operatorUserId: 'e2e',
      operatorPinVerified: true,
      deviceBindingVerified: true,
      spkNumber: `E2E-${TAG}`,
      qrPayload: null,
      capturedAt: now,
      customer: { nama: RETAIL_NAMA, wa: PHONE, alamat: ALAMAT, kontakLain: null, turbolyCustomerId: null },
      vehicle: { noPolisi: PLATE, merk: 'Toyota', tipe: 'Avanza', tahun: 2020, warna: 'Silver', km: '25000', createMakeConfirmed: false },
      complaint: `Servis rutin armada ${COMPANY}`,
      jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
      conditionChecks: [],
      rekomendasiService: null,
      estimasiMinutes: 60,
      serviceAdvisorName: ADVISOR,
      salespersonName: SALES,
      signatures: {
        menyerahkanPresent: true,
        menyerahkanInkDensity: 40,
        menyerahkanNamaJelas: PIC,
        menerimaPresent: true,
        menerimaNamaJelas: ADVISOR,
      },
      attachments: [],
    } as never);
    doc = resolveSkus(doc, mirror.skuFor);
    const unmapped = doc.jobLines.filter((l) => l.ordered && !l.turbolySku);
    if (unmapped.length) fail(`SKU tidak ketemu untuk ${unmapped.map((l) => l.serviceCode).join(', ')} di ${BRANCH}`);
    doc.state = 'awaiting_assignment';
    await collections.spk().insertOne(doc);
    await assignMechanic(doc._id, { mechanicCode: 'E2E', by: 'e2e', via: 'console' });
    spkId = doc._id;
    log(`2/4 ✓ SPK ${spkId} queued (SKU ${doc.jobLines.map((l) => l.turbolySku).join(', ')})`);
  }

  // ── 3. push → Service Order ─────────────────────────────────────────────
  const cur = await collections.spk().findOne({ _id: spkId });
  if (cur && !['pushed', 'confirmed'].includes(cur.state)) {
    if (cur.state === 'failed') {
      await collections.spk().updateOne({ _id: spkId }, { $set: { state: 'queued', 'push.nextAttemptAt': null, updatedAt: new Date().toISOString() } });
      log('   ↻ SPK failed sebelumnya — di-queue ulang');
    }
    log('3/4 push ke Turboly…');
    try {
      await withRetry('push SO', 5, async () => {
        const d0 = await collections.spk().findOne({ _id: spkId });
        // A kicked push leaves the doc `failed` with a transient class — requeue
        // and go again (the SO was never created, so this cannot duplicate).
        if (d0?.state === 'failed' && d0.push?.failureClass !== 'data') {
          await collections.spk().updateOne({ _id: spkId }, { $set: { state: 'queued', 'push.nextAttemptAt': null, updatedAt: new Date().toISOString() } });
        }
        const sinks = new BranchSinks();
        try {
          const r = await pushQueued(sinks, { workerId: 'e2e', onlyId: spkId, log: (m) => log(`   ${m}`) });
          if (r.pushed === 0) {
            const d = await collections.spk().findOne({ _id: spkId });
            throw new Error(`state=${d?.state} ${d?.push?.failureClass ?? ''}: ${d?.push?.lastError ?? '(tidak ada pesan)'}`);
          }
        } finally {
          await sinks.dispose();
        }
      });
    } catch (e) {
      await close();
      return fail(`push gagal — ${(e as Error).message ?? e}`);
    }
  } else {
    log(`3/4 SPK sudah ${cur?.state} — lewati push`);
  }

  const doc = await collections.spk().findOne({ _id: spkId });
  const soUrl = doc?.turboly?.serviceOrderUrl ?? null;
  const soNo = doc?.turboly?.serviceOrderNo ?? null;
  if (!soUrl) {
    await close();
    return fail(`Service Order URL kosong (no=${soNo ?? '-'}) — tidak bisa verifikasi approve`);
  }
  log(`3/4 ✓ Service Order ${soNo} → ${soUrl}`);

  // ── 4. verify APPROVED ──────────────────────────────────────────────────
  log('4/4 verifikasi status APPROVED…');
  try {
    await withRetry('approve SO', 5, async () => {
      const rig = await newRig();
      try {
        await rig.rpa.approveServiceOrder(soUrl);
      } finally {
        await rig.session.dispose().catch(() => {});
      }
    });
  } catch (e) {
    await close();
    return fail(`approve/verifikasi SO — ${(e as Error).message ?? e}`);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  ✓ SUKSES — semua kriteria terpenuhi');
  console.log(`  Wholesale : ${COMPANY} → ${wholesale.companyUrl}`);
  console.log(`  Retail    : ${RETAIL_NAMA} (${PHONE}) → ${wholesale.retail?.customerUrl}`);
  console.log(`  SPK       : ${spkId} (${PLATE})`);
  console.log(`  Service Order APPROVED: ${soNo} → ${soUrl}`);
  console.log('════════════════════════════════════════════════\n');
  await close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await close().catch(() => {});
  process.exit(1);
});
