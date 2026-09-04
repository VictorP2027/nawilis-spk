import {
  connect, close, collections, getDb, buildSpkDoc, loadMirror, resolveSkus, assignMechanic,
} from '@spk/core';
import { BranchSinks } from './sessions.js';
import { pushQueued } from './pushRunner.js';
import { config } from './config.js';

/**
 * SANDBOX ACCEPTANCE RUN for "one car, one SRO".
 *
 * Drives the REAL worker against the REAL Turboly sandbox and then reads the
 * order back, because the only thing this feature is judged on is what the
 * Service Order looks like afterwards:
 *
 *   1. an SPK is captured and queued
 *   2. a Check & Go for the SAME car is captured and queued, checklist included
 *   3. ONE pass of the push runner
 *   4. read the order: it must carry BOTH lines and the inspection list, and
 *      there must be exactly one Service Order for the plate
 *
 * TWO HARD GUARDS, because this writes real orders:
 *   - refuses to run unless TURBOLY_BASE_URL is a sandbox host
 *   - refuses to run against the production database name
 *
 *   TURBOLY_BASE_URL=https://sandbox.turboly.com MONGODB_DB=spk_e2e_merge \
 *     node --import tsx apps/worker/src/e2e-merge-sandbox.ts --branch=NWL-BKS
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const BRANCH = arg('branch') ?? 'NWL-BKS';
const TAG = (arg('tag') ?? String(Date.now()).slice(-5)).toUpperCase();
const ADVISOR = arg('advisor') ?? 'MARCEL ZAKARIA';
/**
 * The vehicle, so the make/type fallback can actually be exercised.
 *
 * Turboly filters the make list by vehicle type, and a motorcycle brand
 * entered with the form's Mobil/Motor toggle left on Mobil is simply absent
 * from the car list — live, a Yamaha Lexi at QS-SRP died on `no Turboly match
 * for "YAMAHA"`. Defaults keep the long-standing Toyota Avanza car run
 * untouched; --make=YAMAHA --model=Lexi --kind=car reproduces that SPK.
 */
/**
 * A job typed into "Pekerjaan lain (tulis / pilih)", verbatim as the form
 * stores it: the typed TEXT is the serviceCode and chosenSku stays null.
 *
 * That is the whole question for a job with no tile of its own — Periodic
 * Maintenance is offered only through that box, and it is worth nothing if it
 * lands in the order's Notes instead of on a billed line. The payload builder
 * is supposed to lift the leading SKU token back out; this proves it does,
 * against the real Turboly form.
 *
 *   --extra="TPI-NAWJAS-PM Periodic Maintenance"
 */
const EXTRA = (arg('extra') ?? '').trim();
const extraSku = (EXTRA.split(/\s+/)[0] ?? '').toUpperCase();
const MAKE = arg('make') ?? 'Toyota';
const MODEL = arg('model') ?? 'Avanza';
const KIND = (arg('kind') ?? 'car') === 'motorcycle' ? 'motorcycle' : 'car';
const SPK_SKU = arg('spk-sku') ?? 'GRS-NAW-SU';
/** A goods SKU that exists in the sandbox catalogue (seen on SO 249185). */
const PART_SKU = arg('part-sku') ?? 'BAN-HAN-16513LV01';
/**
 * A SECOND sparepart, off unless asked for.
 *
 * One goods line proves a sparepart survives the Check & Go re-saving the
 * form; it does not prove that a repair with SEVERAL parts does, and a real
 * repair usually has several. Off by default so the baseline run stays the
 * run that has passed all along.
 */
const PART_SKU2 = (arg('part-sku2') ?? '').trim();
const CHECKGO_SKU = 'JAS-NAWJAS-GC';
const digits = String(Date.now()).slice(-4);
const PLATE = arg('plate') ?? `B${digits}UJI`;
/**
 * The customer's number. Defaults to a mobile; pass an office number
 * (--phone=+6221…) to prove Turboly accepts a landline for a NEW customer —
 * the forms accept them, and a fleet contact often has nothing else.
 */
const PHONE = arg('phone') ?? `+62812${digits}${digits}`;

const log = (m: string): void => console.log(`[e2e-merge ${TAG}] ${m}`);
const fail = (m: string): never => {
  console.error(`\n✗ GAGAL: ${m}\n`);
  process.exit(1);
};

/** The catalogue this run needs, seeded into a scratch database. */
async function seedMirror(): Promise<void> {
  const now = new Date().toISOString();
  const stores = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('../../../data/turboly-sandbox-stores.json', import.meta.url), 'utf8'),
  ) as Array<{ turbolyStoreId: string; turbolyStoreName: string; branchCode: string }>;
  const store = stores.find((s) => s.branchCode === BRANCH) ?? fail(`cabang ${BRANCH} tidak ada di data/turboly-sandbox-stores.json`);
  await collections.tbStores().updateOne(
    { _id: BRANCH },
    { $set: { turbolyStoreId: store.turbolyStoreId, turbolyStoreName: store.turbolyStoreName, syncedAt: now } },
    { upsert: true },
  );
  const services: Array<readonly [string, string]> = [[SPK_SKU, 'Spooring Ulangan'], [CHECKGO_SKU, 'General Check']];
  if (extraSku) services.push([extraSku, EXTRA.split(/\s+/).slice(1).join(' ') || extraSku] as const);
  for (const [sku, name] of services) {
    await collections.tbServiceProducts().updateOne(
      { _id: sku },
      { $set: { sku, name, type: 'service', taxCode: 'PPN', price: 0, masterDurationMin: 30, storeCode: null, syncedAt: now } },
      { upsert: true },
    );
  }
  // Goods must be known as goods, or the payload would send the tyre as a
  // service line and Turboly would refuse it.
  await getDb()
    .collection<{ _id: string; sku: string; syncedAt: string }>('tb_products')
    .updateOne({ _id: PART_SKU }, { $set: { sku: PART_SKU, syncedAt: now } }, { upsert: true });
  await collections.tbServiceProducts().updateOne(
    { _id: PART_SKU },
    { $set: { sku: PART_SKU, name: 'Hankook 165 R13 LV01', type: 'product', taxCode: 'PPN', price: 0, masterDurationMin: 0, storeCode: null, syncedAt: now } },
    { upsert: true },
  );
  if (PART_SKU2) {
    await getDb()
      .collection<{ _id: string; sku: string; syncedAt: string }>('tb_products')
      .updateOne({ _id: PART_SKU2 }, { $set: { sku: PART_SKU2, syncedAt: now } }, { upsert: true });
    await collections.tbServiceProducts().updateOne(
      { _id: PART_SKU2 },
      { $set: { sku: PART_SKU2, name: `Sparepart kedua ${PART_SKU2}`, type: 'product', taxCode: 'PPN', price: 0, masterDurationMin: 0, storeCode: null, syncedAt: now } },
      { upsert: true },
    );
    await collections.serviceSkuMap().updateOne(
      { _id: '*:GANTI_OLI' },
      { $set: { branchCode: null, serviceCode: 'GANTI_OLI', sku: PART_SKU2, matchScore: 1, confirmed: true, updatedAt: now } },
      { upsert: true },
    );
  }
  for (const [code, sku] of [['SPOORING', SPK_SKU], ['GANTI_BAN', PART_SKU], ['CHECKGO', CHECKGO_SKU]] as const) {
    await collections.serviceSkuMap().updateOne(
      { _id: `*:${code}` },
      { $set: { branchCode: null, serviceCode: code, sku, matchScore: 1, confirmed: true, updatedAt: now } },
      { upsert: true },
    );
  }
  await collections.tbMechanics().updateOne(
    { _id: 'E2E' },
    { $set: { mechanicCode: 'E2E', name: ADVISOR, storeCode: null, role: 'advisor', syncedAt: now } },
    { upsert: true },
  );
}

async function capture(kind: 'SPK' | 'CHECKGO'): Promise<string> {
  const now = new Date().toISOString();
  const mirror = await loadMirror(BRANCH);
  let doc = buildSpkDoc({
    uploadId: `e2e-merge-${TAG}-${kind}-${Date.now()}`,
    docType: 'SPK_NAWILIS',
    branchCode: BRANCH,
    captureMode: 'typed',
    operatorUserId: 'e2e',
    operatorPinVerified: true,
    deviceBindingVerified: true,
    spkNumber: `E2E-${TAG}-${kind}`,
    qrPayload: null,
    capturedAt: now,
    customer: { nama: `UJI GABUNG ${TAG}`, wa: PHONE, alamat: 'Jl. Uji Sandbox 1', kontakLain: null, turbolyCustomerId: null },
    vehicle: { noPolisi: PLATE, merk: MAKE, tipe: MODEL, tahun: 2021, warna: 'Silver', km: '31000', kind: KIND, createMakeConfirmed: false },
    complaint: kind === 'SPK' ? 'bunyi roda depan' : 'cek rutin',
    jobLines:
      kind === 'SPK'
        ? [
            { serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: 350000 },
            // The repair's goods. The whole question is whether these survive
            // the Check & Go re-saving the same form.
            { serviceCode: 'GANTI_BAN', ordered: true, qty: 2, keterangan: 'Ban depan', quotedPrice: 500000, chosenSku: PART_SKU },
            ...(PART_SKU2
              ? [{ serviceCode: 'GANTI_OLI', ordered: true, qty: 1, keterangan: 'Sparepart kedua', quotedPrice: 250000, chosenSku: PART_SKU2 }]
              : []),
            // Pekerjaan lain: the typed text IS the serviceCode, chosenSku null.
            ...(EXTRA ? [{ serviceCode: EXTRA, ordered: true, qty: 1, keterangan: null, quotedPrice: null, chosenSku: null }] : []),
          ]
        : [{ serviceCode: 'CHECKGO', ordered: true, qty: 1, keterangan: 'General Check', quotedPrice: 100000, chosenSku: CHECKGO_SKU }],
    conditionChecks: [],
    rekomendasiService: null,
    estimasiMinutes: 60,
    serviceAdvisorName: ADVISOR,
    salespersonName: ADVISOR,
    signatures: { menyerahkanPresent: true, menyerahkanInkDensity: 40, menyerahkanNamaJelas: 'UJI', menerimaPresent: true, menerimaNamaJelas: ADVISOR },
    attachments: [],
  } as never);
  doc = resolveSkus(doc, mirror.skuFor);
  // The free-text line is deliberately unmapped: no service_sku_map entry
  // exists for it, and the payload builder is what turns its leading token
  // into the SKU. Calling that a failure here would fail the very case the
  // run exists to prove.
  const unmapped = doc.jobLines.filter((l) => l.ordered && !l.turbolySku && l.serviceCode !== EXTRA);
  if (unmapped.length) fail(`SKU tidak ketemu untuk ${unmapped.map((l) => l.serviceCode).join(', ')}`);
  doc.state = 'awaiting_assignment';
  if (kind === 'CHECKGO') {
    // Exactly what /api/checkgo stores, including the +30 min plan time and a
    // real checklist — the two things that decide whether this merges at all.
    (doc as unknown as { docType: string }).docType = 'CHECK_AND_GO';
    (doc as unknown as { scheduledAt: string }).scheduledAt = new Date(Date.now() + 30 * 60_000).toISOString();
    (doc as unknown as { checkGo: unknown }).checkGo = {
      harga: 100000,
      report: null,
      inspectionItems: [
        { item: '1. Oli Mesin', hasil: 'Kotor', catatan: 'terakhir ganti Km 20115', feedback: null, inspected: true },
        { item: '2. Sistem Pendingin — Coolant', hasil: 'Bagus', catatan: null, feedback: null, inspected: true },
        { item: '3. Sistem Rem — Kanvas rem depan', hasil: 'Tebal', catatan: null, feedback: null, inspected: true },
      ],
    };
  }
  await collections.spk().insertOne(doc);
  await assignMechanic(doc._id, { mechanicCode: 'E2E', by: 'e2e', via: 'console' });
  log(`  ${kind} ${doc._id} queued (SKU ${doc.jobLines.map((l) => l.turbolySku).join(', ')})`);
  return doc._id;
}

async function main(): Promise<void> {
  if (!/sandbox/i.test(config.turbolyBaseUrl)) fail(`ini HANYA untuk sandbox — TURBOLY_BASE_URL=${config.turbolyBaseUrl}`);
  if (config.mongoDb === 'spk') fail('pakai database terpisah (MONGODB_DB=spk_e2e_merge), jangan database produksi');
  await connect(config.mongoUri, config.mongoDb);
  let sinks: BranchSinks | undefined;
  log(`base=${config.turbolyBaseUrl} db=${config.mongoDb} cabang=${BRANCH} plat=${PLATE} telp=${PHONE} kendaraan=${MAKE} ${MODEL} (${KIND})`);
  try {
    await seedMirror();
    log('1/4 katalog sandbox siap');

    // The counter's real sequence: SPK first, Cek n Go seconds later.
    const spkId = await capture('SPK');
    const cgId = await capture('CHECKGO');
    log('2/4 dua dokumen antre — persis urutan kasir');

    sinks = new BranchSinks();
    const res = await pushQueued(sinks, { workerId: `e2e-${TAG}`, log: (m) => console.log(`      ${m}`) });
    log(`3/4 satu putaran selesai — ${res.candidates} kandidat, ${res.confirmed} confirmed, ${res.failed} gagal`);

    const spk = await collections.spk().findOne({ _id: spkId });
    const cg = await collections.spk().findOne({ _id: cgId });
    const soUrl = spk?.turboly?.serviceOrderUrl ?? null;
    if (!soUrl) fail(`SPK tidak menghasilkan Service Order (state=${spk?.state}, error=${spk?.push?.lastError ?? '-'})`);
    if (cg?.turboly?.serviceOrderUrl) fail(`Cek n Go membuat SO SENDIRI (${cg.turboly.serviceOrderUrl}) — seharusnya menyatu`);
    if (cg?.turboly?.mergedInto?.serviceOrderUrl !== soUrl) {
      fail(`Cek n Go tidak menyatu ke SO SPK (mergedInto=${cg?.turboly?.mergedInto?.serviceOrderUrl ?? 'kosong'}, state=${cg?.state}, error=${cg?.push?.lastError ?? '-'})`);
    }

    // 4. The only verdict that counts: what the Service Order actually shows.
    //    Read as the Check & Go, but pointed at the SPK's order — the same
    //    read-back the runner uses to confirm a merge.
    const asMerged = { ...cg!, turboly: { ...cg!.turboly, serviceOrderUrl: soUrl } };
    const check = await sinks!.withSink(BRANCH, (sink) => sink.verifyByToken(asMerged));
    const rows = (check?.lineSkus ?? []).join(' | ');
    const hasSpkLine = rows.includes(SPK_SKU);
    const hasCheckLine = rows.includes(CHECKGO_SKU);
    if (!rows) log('     (peringatan: baris tidak terbaca — periksa SO-nya sendiri di tautan di atas)');
    log(`4/4 SO ${spk?.turboly?.serviceOrderNo ?? '?'} → ${soUrl}`);
    log(`     baris: ${rows.slice(0, 300) || '(tidak terbaca)'}`);
    log(`     token Cek n Go terbaca: ${check?.found ? 'ya' : 'TIDAK'}`);
    log(`     daftar inspeksi tercatat: ${cg?.checkGo?.inspectionsFilledAt ? 'ya' : `TIDAK (${cg?.checkGo?.inspectionError ?? 'tanpa pesan'})`}`);
    const hasPartLine = rows.includes(PART_SKU);
    log(`     sparepart SPK masih ada: ${hasPartLine ? 'ya' : 'TIDAK'}`);
    if (!hasSpkLine) fail(`baris SPK (${SPK_SKU}) tidak ada di SO`);
    if (!hasPartLine) fail(`SPAREPART SPK (${PART_SKU}) HILANG setelah Cek n Go digabung — inilah yang tidak boleh terjadi`);
    if (PART_SKU2) {
      const hasPart2 = rows.includes(PART_SKU2);
      log(`     sparepart kedua masih ada: ${hasPart2 ? 'ya' : 'TIDAK'}`);
      if (!hasPart2) fail(`SPAREPART KEDUA (${PART_SKU2}) HILANG — perbaikan dengan beberapa part tidak selamat`);
    }
    if (!hasCheckLine) fail(`baris General Check (${CHECKGO_SKU}) tidak ada di SO — persis kegagalan SRO/TA17/26080160`);
    if (extraSku) {
      const hasExtra = rows.includes(extraSku);
      log(`     "Pekerjaan lain" jadi baris beneran: ${hasExtra ? 'ya' : 'TIDAK'} (${extraSku})`);
      if (!hasExtra) fail(`${extraSku} tidak jadi baris jasa — kemungkinan hanya masuk Notes, jadi tidak tertagih`);
    }
    if (!cg?.checkGo?.inspectionsFilledAt) fail('daftar inspeksi tidak terisi');
    console.log(`\n✓ LULUS — satu SRO berisi kedua baris + daftar inspeksi: ${soUrl}\n`);
    await sinks.dispose().catch(() => {});
    await close();
    // Explicit, like push-once: a live Playwright browser keeps the event loop
    // alive, so a PASSING run used to sit there until someone killed it — the
    // work was long done. Only the failing path exited, because fail() does.
    process.exit(0);
  } catch (e) {
    fail((e as Error).message ?? String(e));
  } finally {
    await sinks?.dispose().catch(() => {});
    await close();
  }
}

void main();
