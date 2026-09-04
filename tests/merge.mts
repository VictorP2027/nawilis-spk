/**
 * ONE CAR, ONE SERVICE ORDER — the Check & Go → SPK merge, end to end against a
 * real (in-memory) MongoDB and the REAL push runner, with a stub Turboly.
 *
 * Jane (Turboly, 2026-08-18): "if same car then should be 1 SRO". A Check & Go
 * opens the car's Service Order; the SPK that follows must land its lines on
 * that order, not open a second one. Turboly Service Orders can never be
 * deleted, so every branch of the decision below is exercised — including all
 * the ways the append can NOT happen, because those are where a second order
 * would silently appear.
 *
 *   npm run build -w @spk/core && npx tsx tests/merge.mts
 */

process.env.MERGE_WINDOW_HOURS = '24';
process.env.PUSH_APPROVE = 'false';

import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  connect, close, ensureIndexes, collections,
  buildSpkDoc, resolveSkus, loadMirror, validateLayer1, validateLayer2,
  transition, assignMechanic,
  type SpkIntakeInputT, type SpkDoc,
} from '@spk/core';
import type {
  ServiceOrderSink, PushContext, PushResult, VerifyResult, TurbolyServiceOrderPayload,
  AppendTarget, AppendResult,
} from '@spk/core/turboly';
import { config } from '../apps/worker/src/config.ts';
import { BranchSinks } from '../apps/worker/src/sessions.ts';
import { pushQueued, findCheckGoMergeTarget } from '../apps/worker/src/pushRunner.ts';

// Set on the config object, not through env: ESM hoists imports, so an
// assignment to process.env in this file runs AFTER config.ts has already read
// it. Sections A-S exercise the SPK→Check & Go direction, which ships OFF —
// production keeps the SPK path exactly as it is today.
config.mergeIntoCheckGo = true;
config.mergeCheckGoIntoSpk = true;

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(s: string): void { console.log(`\n── ${s} ──`); }

/**
 * Turboly double. Creates orders like the e2e stub, and can ALSO append: the
 * append records the target it was given and answers with whatever the test
 * scripted, so every runner branch can be driven from here.
 */
// Order numbers are global across stubs: the spk collection has a UNIQUE index
// on turboly.serviceOrderUrl, so a second stub restarting at 1 would collide
// with an earlier section's order (and did — which is that index doing its job).
let soSeq = 260800000;

class StubSink implements ServiceOrderSink {
  readonly mode = 'rpa' as const;
  public created: TurbolyServiceOrderPayload[] = [];
  public appends: Array<{ target: AppendTarget; payload: TurbolyServiceOrderPayload }> = [];
  public appendResult: AppendResult | null = null;
  /** Force the CREATE path's outcome (default: succeeds). */
  public pushResult: PushResult | null = null;
  /** How many times verify-before-recreate actually asked Turboly. */
  public verifyCalls = 0;
  /** Tokens "visible on the order page" per SO URL — what verifyByToken reads. */
  public tokensOn = new Map<string, Set<string>>();

  async pushServiceOrder(payload: TurbolyServiceOrderPayload, _ctx: PushContext): Promise<PushResult> {
    if (this.pushResult) return this.pushResult;
    this.created.push(payload);
    const n = ++soSeq;
    const url = `https://sandbox.turboly.com/service_orders/${n}`;
    this.tokensOn.set(url, new Set([payload.correlationToken]));
    return { ok: true, serviceOrderNo: `SRO/BKS/${n}`, workOrderNo: null, verified: null, screenshotRef: null, serviceOrderUrl: url, approved: null };
  }
  async appendLinesToServiceOrder(target: AppendTarget, payload: TurbolyServiceOrderPayload, _ctx: PushContext): Promise<AppendResult> {
    this.appends.push({ target, payload });
    const typed = target.inspections?.rows.length ?? 0;
    const r = this.appendResult ?? {
      ok: true,
      serviceOrderNo: `SRO/BKS/${/(\d+)$/.exec(target.serviceOrderUrl)?.[1]}`,
      // the real form takes the checklist in the same save (sandbox-verified)
      ...(typed ? { inspectionsWritten: typed } : {}),
    };
    if (r.ok) this.tokensOn.get(target.serviceOrderUrl)?.add(target.spkToken);
    return r;
  }
  async verifyByToken(doc: SpkDoc): Promise<VerifyResult> {
    this.verifyCalls += 1;
    // The real sink SEARCHES Turboly for the token — it does not need the doc to
    // already know a URL. That is the whole point of verify-before-recreate
    // after a crash, and after a died append the token can be sitting on the
    // Check & Go's order, which this doc has never recorded.
    const known = doc.turboly.serviceOrderUrl ?? '';
    const url = this.tokensOn.get(known)?.has(doc.push.correlationToken)
      ? known
      : ([...this.tokensOn].find(([, toks]) => toks.has(doc.push.correlationToken))?.[0] ?? '');
    if (!url) return { found: false, serviceOrderNo: null, serviceOrderUrl: null, store: null, lineCount: null, lineSkus: [], km: null };
    // The real sink reports WHICH order page the token was on — that URL is how
    // the runner tells "my own order" from "the Check & Go's order".
    return { found: true, serviceOrderNo: `SRO/BKS/${/(\d+)$/.exec(url)?.[1]}`, serviceOrderUrl: url, store: null, lineCount: 1, lineSkus: [], km: null };
  }
  async canary() { return { ok: true, controlHash: 'stub' }; }
}

function intake(over: Partial<SpkIntakeInputT> = {}): SpkIntakeInputT {
  return {
    uploadId: `u-${Math.random().toString(36).slice(2)}`,
    docType: 'SPK_NAWILIS', branchCode: 'NWL-BKS', captureMode: 'typed',
    operatorUserId: 'rina', operatorPinVerified: true, deviceBindingVerified: true,
    spkNumber: null, qrPayload: null, capturedAt: new Date().toISOString(),
    customer: { nama: 'Budi Santoso', wa: '081234567890', alamat: 'Jl. Test 1', kontakLain: null, turbolyCustomerId: null },
    vehicle: { noPolisi: 'B1743BKA', merk: 'Toyota', tipe: 'Avanza', tahun: 2019, warna: 'Silver', km: '45.230' },
    complaint: 'bunyi di roda depan',
    jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: '4 roda', quotedPrice: 350000 }],
    conditionChecks: [], rekomendasiService: null, estimasiMinutes: null,
    serviceAdvisorName: 'Rina S', salespersonName: 'Rina S',
    signatures: { menyerahkanPresent: true, menyerahkanInkDensity: 0.08, menerimaPresent: true, menerimaNamaJelas: 'Rina S' },
    attachments: [],
    ...over,
  } as SpkIntakeInputT;
}

/** Same as tests/e2e.mts: build → validate → park at awaiting_assignment. */
async function ingest(input: SpkIntakeInputT): Promise<string> {
  let doc = buildSpkDoc(input);
  doc.uploadId = input.uploadId;
  if (input.serviceAdvisorName) doc.signatures.menerima.namaJelas = input.serviceAdvisorName;
  const mirror = await loadMirror(doc.branchCode);
  doc = resolveSkus(doc, mirror.skuFor);
  const prior = await collections.vehicles().findOne({ plateVariants: { $in: doc.vehicle.plateVariants } });
  validateLayer1(doc, prior);
  await collections.spk().insertOne(doc);
  await transition(doc._id, 'captured', 'extracted');
  await transition(doc._id, 'extracted', 'needs_review');
  validateLayer2(doc, { mirror, serviceAdvisorName: input.serviceAdvisorName, salespersonName: input.salespersonName ?? input.serviceAdvisorName, planServiceDate: null, planServiceTime: null });
  await transition(doc._id, 'needs_review', 'validated');
  await transition(doc._id, 'validated', 'awaiting_assignment');
  return doc._id;
}

/** A queued SPK for `plate` at `branch`. */
async function queuedSpk(plate = 'B1743BKA', branch = 'NWL-BKS'): Promise<string> {
  const id = await ingest(intake({ branchCode: branch, vehicle: { noPolisi: plate, merk: 'Toyota', tipe: 'Avanza', tahun: 2019, warna: 'Silver', km: '45.230' } }));
  const a = await assignMechanic(id, { mechanicCode: 'M001', by: 'test', via: 'console' });
  if (a?.state !== 'queued') throw new Error(`not queued: ${a?.state}`);
  return id;
}

/**
 * A Check & Go for `plate`: same doc shape the /api/checkgo route stores —
 * INCLUDING `scheduledAt = now + 30 min`, which that route stamps on every
 * single Check & Go (PLAN_OFFSET_MINUTES). Leaving it out is how the tests
 * missed that the "booked appointment" rule was suppressing every merge.
 */
async function queuedCheckGo(plate = 'B1743BKA', branch = 'NWL-BKS'): Promise<string> {
  const id = await queuedSpk(plate, branch);
  await collections.spk().updateOne(
    { _id: id },
    {
      $set: {
        docType: 'CHECK_AND_GO',
        scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        checkGo: { harga: 100000, inspectionItems: [], report: null },
      },
    },
  );
  return id;
}

async function pushOne(id: string, stub: StubSink, log: string[] = []): Promise<SpkDoc> {
  const sinks = new BranchSinks(async () => stub);
  await pushQueued(sinks, { workerId: 'w-test', onlyId: id, log: (m) => log.push(m) });
  return (await collections.spk().findOne({ _id: id }))!;
}

async function seedMirror(): Promise<void> {
  const now = new Date().toISOString();
  await collections.tbStores().insertMany([
    { _id: 'NWL-BKS', turbolyStoreId: '7', turbolyStoreName: 'Nawilis Bekasi', syncedAt: now },
    { _id: 'NWL-BGR', turbolyStoreId: '8', turbolyStoreName: 'Nawilis Bogor', syncedAt: now },
  ]);
  await collections.tbServiceProducts().insertOne({ _id: 'JASA-SPOOR', sku: 'JASA-SPOOR', name: 'Spooring', type: 'service', taxCode: 'PPN', price: 350000, masterDurationMin: 30, storeCode: null, syncedAt: now });
  await collections.tbMechanics().insertOne({ _id: 'M001', mechanicCode: 'M001', name: 'Rina S', storeCode: null, role: 'advisor', syncedAt: now });
  await collections.tbServiceProducts().insertOne({ _id: 'SP-PENTIL', sku: 'SP-PENTIL', name: 'Pentil Karet', type: 'product', taxCode: 'PPN', price: 20000, masterDurationMin: 0, storeCode: null, syncedAt: now });
  await collections.serviceSkuMap().insertMany([
    { _id: '*:SPOORING', branchCode: null, serviceCode: 'SPOORING', sku: 'JASA-SPOOR', matchScore: 1, confirmed: true, updatedAt: now },
    { _id: '*:PENTIL_KARET', branchCode: null, serviceCode: 'PENTIL_KARET', sku: 'SP-PENTIL', matchScore: 1, confirmed: true, updatedAt: now },
  ]);
}

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  await connect(mongod.getUri(), 'spkmerge');
  await ensureIndexes();
  await seedMirror();

  // ───────────────────────────────────────────────────────────────────────
  section('A. Check & Go first, SPK second, same car → lines appended, ONE order');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo(), stub);
    ok(cg.state === 'confirmed' && !!cg.turboly.serviceOrderUrl, `Check & Go pushed and confirmed (${cg.turboly.serviceOrderNo})`);
    ok(stub.created.length === 1, 'the Check & Go opened the car\'s order');

    const log: string[] = [];
    const spk = await pushOne(await queuedSpk(), stub, log);
    ok(stub.appends.length === 1, 'the SPK was APPENDED, not created');
    ok(stub.created.length === 1, 'still exactly ONE Service Order for the car');
    const ap = stub.appends[0]!;
    ok(ap.target.serviceOrderUrl === cg.turboly.serviceOrderUrl, 'appended onto the Check & Go\'s order URL');
    ok(ap.target.expectedPlate === 'B1743BKA', `sink is told which plate the order must show (${ap.target.expectedPlate})`);
    ok(ap.target.spkToken === spk.push.correlationToken, 'sink is given the SPK token to stamp on the order');
    ok(ap.payload.serviceLines.length === 1 && ap.payload.serviceLines[0]!.expectedSku === 'JASA-SPOOR', 'the SPK\'s own lines are what gets appended');
    ok(spk.state === 'confirmed', `SPK ends confirmed (got ${spk.state})`);
    ok(spk.turboly.mergedInto?.spkId === cg._id, 'SPK records which Check & Go it merged into');
    ok(spk.turboly.serviceOrderNo === cg.turboly.serviceOrderNo, 'SPK carries the Check & Go\'s order number');
    ok(spk.turboly.serviceOrderUrl == null, 'SPK does NOT take the URL (unique per doc — it stays the Check & Go\'s)');
    ok(spk.turboly.readback.matchedOn.includes('merged_into_checkgo'), 'read-back names the merge');
    const cg2 = (await collections.spk().findOne({ _id: cg._id }))!;
    ok((cg2.checkGo?.mergedSpkIds ?? []).includes(spk._id), 'Check & Go lists the merged SPK');
    ok(log.some((l) => /digabung ke SO/.test(l)), 'runner log says digabung');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('B. Retry after a died append: token already on the order → adopted, nothing typed');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo('B2222AB'), stub);
    stub.appendResult = { ok: true, serviceOrderNo: cg.turboly.serviceOrderNo, alreadyAppended: true };
    // What the real sink does when it SEES the token: report it; make it visible for verify.
    const id = await queuedSpk('B2222AB');
    const tok = (await collections.spk().findOne({ _id: id }))!.push.correlationToken;
    stub.tokensOn.get(cg.turboly.serviceOrderUrl!)!.add(tok);
    const spk = await pushOne(id, stub);
    ok(spk.state === 'confirmed' && spk.turboly.mergedInto?.spkId === cg._id, 'adopted as merged and confirmed');
    ok(stub.created.length === 1, 'no second order');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('C. Append cannot START (plate mismatch / no Edit / controls missing) → falls back to a separate order');
  {
    const stub = new StubSink();
    await pushOne(await queuedCheckGo('B3333AB'), stub);
    stub.appendResult = { ok: false, serviceOrderNo: null, fallbackToCreate: true, failureClass: 'data', error: 'plat di SO Check & Go bukan B3333AB' };
    const spk = await pushOne(await queuedSpk('B3333AB'), stub);
    ok(stub.appends.length === 1, 'append was attempted');
    ok(stub.created.length === 2, 'fell back to creating a SEPARATE order (behaviour before this feature)');
    ok(spk.state === 'confirmed' && !spk.turboly.mergedInto, `SPK confirmed on its own order (got ${spk.state})`);
    ok(spk.push.mergeAttempt?.fellBack === true && /B3333AB/.test(spk.push.mergeAttempt?.error ?? ''), 'the failed attempt is stamped on the doc');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('D. Save clicked, outcome unknown → manual_intervention, and NO second order');
  {
    const stub = new StubSink();
    await pushOne(await queuedCheckGo('B4444AB'), stub);
    stub.appendResult = { ok: false, serviceOrderNo: null, fallbackToCreate: false, failureClass: 'structural', error: 'simpan gabungan tidak terkonfirmasi — CEK MANUAL' };
    const spk = await pushOne(await queuedSpk('B4444AB'), stub);
    ok(spk.state === 'manual_intervention', `parked for a human (got ${spk.state})`);
    ok(stub.created.length === 1, 'NO second order was created on "unknown"');
    ok(/CEK MANUAL/.test(spk.push.lastError ?? ''), 'the doc says why');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('E. Session kicked before Save → failed (transient), attempt refunded, retried later, NO order');
  {
    const stub = new StubSink();
    await pushOne(await queuedCheckGo('B5555AB'), stub);
    stub.appendResult = { ok: false, serviceOrderNo: null, fallbackToCreate: false, failureClass: 'transient', error: 'sesi ter-kick' };
    const id = await queuedSpk('B5555AB');
    const before = (await collections.spk().findOne({ _id: id }))!.push.attempt;
    const spk = await pushOne(id, stub);
    ok(spk.state === 'failed' && spk.push.failureClass === 'transient', `transient failure recorded (got ${spk.state}/${spk.push.failureClass})`);
    ok(spk.push.attempt === before, 'attempt refunded (a vendor blip must not eat retries)');
    ok(stub.created.length === 1, 'no order created');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('F. Check & Go still in flight → SPK WAITS (back to queued), no race into two orders');
  {
    const stub = new StubSink();
    await queuedCheckGo('B6666AB'); // queued, never pushed
    const id = await queuedSpk('B6666AB');
    const before = (await collections.spk().findOne({ _id: id }))!.push.attempt;
    const log: string[] = [];
    const spk = await pushOne(id, stub, log);
    ok(spk.state === 'queued', `SPK released back to queued (got ${spk.state})`);
    ok(spk.push.attempt === before, 'the wait costs no attempt');
    ok(stub.appends.length === 0 && stub.created.length === 0, 'nothing touched Turboly');
    ok(log.some((l) => /menunggu Check & Go/.test(l)), 'runner log says it is waiting');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('G. The decision itself: what is and is not the same visit');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo('B7777AB'), stub);
    const spk = (await collections.spk().findOne({ _id: await queuedSpk('B7777AB') }))!;
    let d = await findCheckGoMergeTarget(spk, 24);
    ok(d.target?.spkId === cg._id, 'same plate, same branch, inside window → target');

    const other = (await collections.spk().findOne({ _id: await queuedSpk('B7778AB') }))!;
    d = await findCheckGoMergeTarget(other, 24);
    ok(!d.target && !d.hold, 'different plate → no target');

    const otherBranch = (await collections.spk().findOne({ _id: await queuedSpk('B7777AB', 'NWL-BGR') }))!;
    d = await findCheckGoMergeTarget(otherBranch, 24);
    ok(!d.target && !d.hold, 'same plate at ANOTHER branch → no target (an order belongs to a store)');

    // The window is anchored on the SPK's own capture, not on the wall clock,
    // so age the CHECK & GO — a check from last week is a different visit even
    // if this SPK is pushed the moment it is captured (see section O).
    await collections.spk().updateOne({ _id: cg._id }, { $set: { createdAt: new Date(Date.parse(spk.createdAt) - 25 * 3600_000).toISOString() } });
    d = await findCheckGoMergeTarget(spk, 24);
    ok(!d.target, 'outside the window → no target (a check last week is a different visit)');
    await collections.spk().updateOne({ _id: cg._id }, { $set: { createdAt: cg.createdAt } });

    await collections.spk().updateOne({ _id: cg._id }, { $set: { 'flow.invoice': 'draft' } });
    d = await findCheckGoMergeTarget(spk, 24);
    ok(!d.target && /berinvoice/.test(d.note ?? ''), 'Check & Go already invoiced → visit closed, no target');
    await collections.spk().updateOne({ _id: cg._id }, { $unset: { 'flow.invoice': '' } });

    // plateVariants share OCR variants across DIFFERENT plates: the decision must
    // be on the exact plate, never on the index hit alone.
    await collections.spk().updateOne({ _id: cg._id }, { $addToSet: { 'vehicle.plateVariants': 'B7779AB' } });
    const variantOnly = (await collections.spk().findOne({ _id: await queuedSpk('B7779AB') }))!;
    d = await findCheckGoMergeTarget(variantOnly, 24);
    ok(!d.target, 'a plateVariants hit with a different exact plate is NOT the same car');

    // A Check & Go still in flight is always a HOLD here — how long this SPK
    // has already waited is the runner's business (push.mergeHoldSince), not
    // the candidate's updatedAt, which every retry rewrites. Section P proves
    // the waiting actually ends.
    const stuckId = await queuedCheckGo('B7780AB');
    await collections.spk().updateOne({ _id: stuckId }, { $set: { updatedAt: new Date(Date.now() - 45 * 60_000).toISOString() } });
    const late = (await collections.spk().findOne({ _id: await queuedSpk('B7780AB') }))!;
    d = await findCheckGoMergeTarget(late, 24);
    ok(d.hold?.spkId === stuckId, 'an in-flight Check & Go is a hold — the give-up clock belongs to the SPK, not to it');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('H. A Check & Go itself is never merged into another Check & Go');
  {
    const stub = new StubSink();
    await pushOne(await queuedCheckGo('B8888AB'), stub);
    const cg2 = await pushOne(await queuedCheckGo('B8888AB'), stub);
    ok(stub.appends.length === 0 && stub.created.length === 2 && cg2.state === 'confirmed', 'second Check & Go for the same car gets its own order');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('I. The wait does not spin: a held SPK is skipped by the queue until its recheck time');
  {
    // Earlier sections left docs parked in `queued`; this one runs the WHOLE
    // queue, so start from a clean board.
    await collections.spk().deleteMany({ state: 'queued' });
    const stub = new StubSink();
    const cgId = await queuedCheckGo('B9001AB');
    const spkId = await queuedSpk('B9001AB');
    const held = await pushOne(spkId, stub);
    ok(held.state === 'queued' && Date.parse(held.push.nextAttemptAt ?? '') > Date.now(), 'the held SPK asks to be left alone for a few minutes');

    // One normal pass of the queue — exactly what the cron and the push-once
    // grace loop do. Before this fix the held SPK was re-claimed every pass.
    const sinks = new BranchSinks(async () => stub);
    await pushQueued(sinks, { workerId: 'w-test' });
    const cg = (await collections.spk().findOne({ _id: cgId }))!;
    const still = (await collections.spk().findOne({ _id: spkId }))!;
    ok(cg.state === 'confirmed', 'that pass pushed the Check & Go itself');
    ok(still.state === 'queued' && still.push.attempt === held.push.attempt, 'the held SPK was not re-claimed (no attempt burned, no spin against Turboly)');
    ok(stub.appends.length === 0, 'and nothing was appended yet');

    // When the recheck time comes it finds the finished order and merges.
    await collections.spk().updateOne({ _id: spkId }, { $set: { 'push.nextAttemptAt': new Date(Date.now() - 1000).toISOString() } });
    await pushQueued(sinks, { workerId: 'w-test' });
    const done = (await collections.spk().findOne({ _id: spkId }))!;
    ok(done.state === 'confirmed' && done.turboly.mergedInto?.spkId === cgId, 'after the wait it merges into the Check & Go\'s order');
    ok(stub.created.length === 1, 'one car, ONE order');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('J. A booked appointment for another day is its own visit, never merged');
  {
    const stub = new StubSink();
    await pushOne(await queuedCheckGo('B9002AB'), stub);
    const id = await queuedSpk('B9002AB');
    await collections.spk().updateOne({ _id: id }, { $set: { scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() } });
    const spk = await pushOne(id, stub);
    ok(stub.appends.length === 0, 'no append: today\'s Check & Go order is not next Friday\'s work');
    ok(stub.created.length === 2 && spk.state === 'confirmed' && !spk.turboly.mergedInto, 'the appointment gets its own order, as before');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('K. Nothing to append (sparepart-only SPK) → own order, never a silent half-merge');
  {
    const stub = new StubSink();
    await pushOne(await queuedCheckGo('B9003AB'), stub);
    const id = await ingest(intake({
      vehicle: { noPolisi: 'B9003AB', merk: 'Toyota', tipe: 'Avanza', tahun: 2019, warna: 'Silver', km: '45.230' },
      jobLines: [{ serviceCode: 'PENTIL_KARET', ordered: true, qty: 4, keterangan: null, quotedPrice: 20000 }],
    }));
    await assignMechanic(id, { mechanicCode: 'M001', by: 'test', via: 'console' });
    const spk = await pushOne(id, stub);
    const payload = stub.created[1]!;
    ok(payload.serviceLines.length === 0 && payload.sparepartLines.length === 1, 'this SPK really is goods-only');
    ok(stub.appends.length === 0, 'not appended: the identity token rides on a SERVICE line, so a goods-only append could never be proven');
    ok(stub.created.length === 2 && spk.state === 'confirmed', 'it gets its own order instead');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('L. The NEWEST Check & Go decides, and a plate that names no car never merges');
  {
    const stub = new StubSink();
    const old1 = await pushOne(await queuedCheckGo('B9004AB'), stub); // yesterday's check, confirmed
    const fresh = await queuedCheckGo('B9004AB');                     // today's check, still in flight
    const spk = (await collections.spk().findOne({ _id: await queuedSpk('B9004AB') }))!;
    const d = await findCheckGoMergeTarget(spk, 24);
    ok(!d.target && d.hold?.spkId === fresh, 'waits for TODAY\'s check instead of appending to the older finished one');
    ok(old1.state === 'confirmed', '(the older one is confirmed and would have been an easy wrong answer)');

    // A retryable vendor blip on the Check & Go is still "in flight".
    await collections.spk().updateOne({ _id: fresh }, { $set: { state: 'failed', 'push.failureClass': 'transient' } });
    const d2 = await findCheckGoMergeTarget(spk, 24);
    ok(d2.hold?.spkId === fresh, 'a Check & Go between two automatic retries is waited for, not overtaken');

    // Placeholder plates ("BARU", "-", "XXX") are not identities.
    await collections.spk().updateOne({ _id: fresh }, { $set: { 'vehicle.noPolisi.full': 'BARU' } });
    const anon = { ...spk, vehicle: { ...spk.vehicle, noPolisi: { ...spk.vehicle.noPolisi, full: 'BARU' } } } as SpkDoc;
    const d3 = await findCheckGoMergeTarget(anon, 24);
    ok(!d3.target && !d3.hold, 'a placeholder plate is never treated as "the same car"');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('M. Crash after the append committed: the retry adopts the merge instead of re-creating');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo('B9005AB'), stub);
    const id = await queuedSpk('B9005AB');
    const tok = (await collections.spk().findOne({ _id: id }))!.push.correlationToken;
    // The append committed on the Check & Go's order, then the runner died
    // before writing anything: doc back in queued, attempt already spent.
    stub.tokensOn.get(cg.turboly.serviceOrderUrl!)!.add(tok);
    // The doc itself knows nothing — the runner died before writing. Only the
    // token, sitting on Turboly, records what happened.
    await collections.spk().updateOne({ _id: id }, { $set: { 'push.attempt': 1, 'push.reclaimed': true } });
    // Meanwhile the Check & Go was invoiced, so the merge branch no longer
    // offers it as a target: ONLY verify-before-recreate stands between this
    // retry and a duplicate order.
    await collections.spk().updateOne({ _id: cg._id }, { $set: { 'flow.invoice': 'draft' } });
    const spk = await pushOne(id, stub);
    ok(stub.created.length === 1, 'no second order: the token was found on the Check & Go\'s order first');
    ok(spk.turboly.mergedInto?.spkId === cg._id, 'and the adopted order is recorded as a MERGE, not as this SPK\'s own order');
    ok(spk.turboly.serviceOrderUrl == null, 'the URL stays the Check & Go\'s (one doc owns it)');
    const cg2 = (await collections.spk().findOne({ _id: cg._id }))!;
    ok((cg2.checkGo?.mergedSpkIds ?? []).includes(id), 'the Check & Go lists it too');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('N. Check & Go whose Work Order already exists: still ONE order, but said out loud');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo('B9006AB'), stub);
    await collections.spk().updateOne({ _id: cg._id }, { $set: { 'flow.wo': 'created', 'flow.workOrderNo': 'WO/BKS/26080001' } });
    const log: string[] = [];
    const spk = await pushOne(await queuedSpk('B9006AB'), stub, log);
    ok(spk.turboly.mergedInto?.spkId === cg._id && stub.created.length === 1, 'still merged — a second SRO could never be deleted');
    ok(log.some((l) => /Work Order WO\/BKS\/26080001/.test(l)), 'the log tells the branch to add the lines to the WO as well');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('O. The visit is anchored on the SPK, and a dead Check & Go cannot veto a live one');
  {
    const stub = new StubSink();
    // O1. A Check & Go from a LATER visit must not adopt an older SPK's work.
    const spkId = await queuedSpk('B9101AB');
    await collections.spk().updateOne({ _id: spkId }, { $set: { createdAt: new Date(Date.now() - 20 * 3600_000).toISOString() } });
    // With the Cek n Go direction on, that later Check & Go would itself join
    // the SPK's order — which is the point of section T. Here we only want it
    // to exist as a candidate, so it makes its own order.
    config.mergeCheckGoIntoSpk = false;
    const laterCg = await pushOne(await queuedCheckGo('B9101AB'), stub); // created now = after the SPK
    config.mergeCheckGoIntoSpk = true;
    const spk = (await collections.spk().findOne({ _id: spkId }))!;
    let d = await findCheckGoMergeTarget(spk, 24);
    ok(!d.target && !d.hold, 'a Check & Go opened AFTER this SPK is a different visit — not its order');
    ok(laterCg.state === 'confirmed', '(and it really is confirmed, so only the anchor kept it out)');

    // O2. The newest candidate is unusable (its own push failed for good); an
    // older one still has an open order → merge there instead of a second SRO.
    const openCg = await pushOne(await queuedCheckGo('B9102AB'), stub);
    const deadCg = await queuedCheckGo('B9102AB');
    await collections.spk().updateOne({ _id: deadCg }, { $set: { state: 'failed', 'push.failureClass': 'data' } });
    const spk2 = (await collections.spk().findOne({ _id: await queuedSpk('B9102AB') }))!;
    d = await findCheckGoMergeTarget(spk2, 24);
    ok(d.target?.spkId === openCg._id, 'a permanently failed newer Check & Go does not veto the older open one');
    ok(/tidak bisa digabung/.test(d.note ?? ''), 'and the skipped one is explained');

    // O3. Same, for a newest one whose visit is already invoiced.
    const openCg2 = await pushOne(await queuedCheckGo('B9103AB'), stub);
    const billed = await pushOne(await queuedCheckGo('B9103AB'), stub);
    await collections.spk().updateOne({ _id: billed._id }, { $set: { 'flow.invoice': 'draft' } });
    const spk3 = (await collections.spk().findOne({ _id: await queuedSpk('B9103AB') }))!;
    d = await findCheckGoMergeTarget(spk3, 24);
    ok(d.target?.spkId === openCg2._id, 'an invoiced newer visit is skipped, not treated as a veto');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('P. Waiting has an end: the cap runs on the SPK\'s own clock');
  {
    const stub = new StubSink();
    await queuedCheckGo('B9104AB'); // never pushed — stays in flight
    const id = await queuedSpk('B9104AB');
    const first = await pushOne(id, stub);
    ok(first.state === 'queued' && !!first.push.mergeHoldSince, 'the first hold stamps when the waiting started');

    // The Check & Go keeps retrying, so ITS updatedAt is fresh — the old cap
    // (measured on the target) could never fire. The SPK's own clock can.
    await collections.spk().updateOne({ _id: id }, { $set: { 'push.mergeHoldSince': new Date(Date.now() - 31 * 60_000).toISOString(), 'push.nextAttemptAt': new Date(Date.now() - 1000).toISOString() } });
    const log: string[] = [];
    const spk = await pushOne(id, stub, log);
    ok(spk.state === 'confirmed' && !spk.turboly.mergedInto, 'after 30 minutes it stops waiting and makes its own SO');
    ok(log.some((l) => /tidak ditunggu lagi/.test(l)), 'and says so');
    ok(spk.push.mergeHoldSince == null, 'the waiting stamp is cleared');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('Q. An interrupted append never becomes a second order, even if the target vanishes');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo('B9105AB'), stub);
    stub.appendResult = { ok: false, serviceOrderNo: null, fallbackToCreate: false, failureClass: 'transient', error: 'sesi ter-kick sesudah Save' };
    const id = await queuedSpk('B9105AB');
    const failed = await pushOne(id, stub);
    ok(failed.state === 'failed' && failed.push.mergeAttempt?.fellBack === false, 'the interrupted attempt is recorded on the doc');
    ok(failed.push.attempt === 0, 'a vendor blip still refunds the attempt (which is why the retry guard cannot rely on it)');

    // Before the retry, the Check & Go's visit closes: there is no target left.
    await collections.spk().updateOne({ _id: cg._id }, { $set: { 'flow.invoice': 'draft' } });
    await collections.spk().updateOne({ _id: id }, { $set: { state: 'queued', 'push.nextAttemptAt': null } });
    stub.appendResult = null;
    const retried = await pushOne(id, stub);
    ok(stub.created.length === 1, 'NO second order was created for the SPK');
    ok(retried.state === 'manual_intervention', `parked for a human instead (got ${retried.state})`);
    ok(/CEK MANUAL/.test(retried.push.lastError ?? ''), 'and the doc says what to check');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('R. A crash-adopted Check & Go keeps its order URL, so the next SPK still merges');
  {
    const stub = new StubSink();
    // Check & Go pushed, then the runner died before recording anything.
    const cgId = await queuedCheckGo('B9106AB');
    const cgDoc = (await collections.spk().findOne({ _id: cgId }))!;
    const url = `https://sandbox.turboly.com/service_orders/${++soSeq}`;
    stub.tokensOn.set(url, new Set([cgDoc.push.correlationToken]));
    await collections.spk().updateOne({ _id: cgId }, { $set: { 'push.attempt': 1, 'push.reclaimed': true } });
    const cg = await pushOne(cgId, stub);
    ok(cg.state === 'confirmed' && !cg.turboly.mergedInto, 'the Check & Go adopted its own order (not a merge)');
    ok(cg.turboly.serviceOrderUrl === url, 'and RECOVERED the order URL — without it the next SPK could never merge');

    const spk = await pushOne(await queuedSpk('B9106AB'), stub);
    ok(spk.turboly.mergedInto?.spkId === cgId && stub.created.length === 0, 'the SPK merges into it: one car, one order');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('S. What a human must still do is written on the document, not only in the log');
  {
    const stub = new StubSink();
    const cg = await pushOne(await queuedCheckGo('B9107AB'), stub);
    await collections.spk().updateOne({ _id: cg._id }, { $set: { 'flow.wo': 'created', 'flow.workOrderNo': 'WO/BKS/26080009' } });
    stub.appendResult = { ok: true, serviceOrderNo: cg.turboly.serviceOrderNo, notesCarried: false, approvalReset: true, inspectionsLost: true };
    const spk = await pushOne(await queuedSpk('B9107AB'), stub);
    const w = spk.turboly.mergedInto?.warnings ?? [];
    ok(w.length === 4, `all four warnings stored on the doc (got ${w.length})`);
    ok(w.some((x) => /daftar inspeksi/.test(x)), 'a shrunken inspection list is reported (the Check & Go checklist is re-fillable from our own data)');
    ok(w.some((x) => /Work Order WO\/BKS\/26080009/.test(x)), 'WO already made → add the lines there too');
    ok(w.some((x) => /[Cc]atatan SPK/.test(x)), 'notes could not be carried');
    ok(w.some((x) => /PENDING APPROVAL/.test(x)), 'the order needs approving again (VERIFIED in sandbox 2026-08-18)');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('T. THE REAL FLOW — SPK first, Cek n Go second, one SRO (Turboly: "SPK first..")');
  {
    const stub = new StubSink();
    // The SPK behaves exactly as it always has: it creates the car's order.
    config.mergeIntoCheckGo = false;
    const spk = await pushOne(await queuedSpk('B9201AB'), stub);
    ok(spk.state === 'confirmed' && !!spk.turboly.serviceOrderUrl, 'SPK made its own Service Order, unchanged');
    ok(stub.created.length === 1 && stub.appends.length === 0, 'nothing about the SPK path changed');

    // The Cek n Go arrives second and joins that order instead of opening one.
    const log: string[] = [];
    const cg = await pushOne(await queuedCheckGo('B9201AB'), stub, log);
    ok(stub.created.length === 1, 'still ONE Service Order for the car — no backlog of SROs for one plate');
    ok(stub.appends.length === 1, 'the Check & Go was APPENDED to the SPK\'s order');
    ok(stub.appends[0]!.target.serviceOrderUrl === spk.turboly.serviceOrderUrl, 'onto the SPK\'s order URL');
    ok(cg.state === 'confirmed', `Check & Go ends confirmed (got ${cg.state})`);
    ok(cg.turboly.mergedInto?.spkId === spk._id, 'and records which SPK order it joined');
    ok(cg.turboly.serviceOrderUrl == null, 'it does not claim the URL — one order, one owner');
    const spk2 = (await collections.spk().findOne({ _id: spk._id }))!;
    ok((spk2.checkGo?.mergedSpkIds ?? []).includes(cg._id), 'the SPK lists the Check & Go that joined it');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('U. A Cek n Go that joins an SPK order still delivers its inspection list');
  {
    const stub = new StubSink();
    config.mergeIntoCheckGo = false;
    const spk = await pushOne(await queuedSpk('B9202AB'), stub);
    const cgId = await queuedCheckGo('B9202AB');
    // A real Check & Go carries its checklist from intake.
    await collections.spk().updateOne({ _id: cgId }, { $set: { 'checkGo.inspectionItems': [
      { item: '1. Oli Mesin', hasil: 'Kotor', catatan: 'terakhir ganti Km 20115', feedback: null, inspected: true },
      { item: '3. Kanvas rem depan', hasil: 'Tebal', catatan: null, feedback: null, inspected: true },
    ] } });
    const log: string[] = [];
    const cg = await pushOne(cgId, stub, log);
    ok(cg.turboly.mergedInto?.serviceOrderUrl === spk.turboly.serviceOrderUrl, 'joined the SPK order');
    // The checklist rides along in the SAME save as the line. The old route —
    // a second HTTP round trip that re-submits the whole order — is what
    // Turboly refused on the first merged order in production (HTTP 200).
    const sent = stub.appends.at(-1)!.target.inspections;
    ok(sent?.rows.length === 2, `both checklist rows were handed to the form (got ${sent?.rows.length ?? 0})`);
    ok(sent?.category === 'NAWILIS CHECK & GO', 'under the Check & Go category');
    ok(sent?.rows[0]?.description === '1. Oli Mesin' && /Kotor/.test(sent?.rows[0]?.notes ?? ''), 'item → Description, finding → Feedback');
    const after = (await collections.spk().findOne({ _id: cgId }))!;
    ok(!!after.checkGo?.inspectionsFilledAt, 'the document records that the list was written');
    ok(log.some((l) => /inspection list terisi .*form gabungan/.test(l)), 'and the runner says it went in with the merge');

    // When the form cannot take it (order past DRAFT), the HTTP writer is tried.
    const stub2 = new StubSink();
    const spk2 = await pushOne(await queuedSpk('B9203CD'), stub2);
    const cg2Id = await queuedCheckGo('B9203CD');
    await collections.spk().updateOne({ _id: cg2Id }, { $set: { 'checkGo.inspectionItems': [{ item: 'Aki', hasil: null, catatan: 'Lemah', feedback: null, inspected: true }] } });
    stub2.appendResult = { ok: true, serviceOrderNo: spk2.turboly.serviceOrderNo, inspectionsWritten: null };
    const log2: string[] = [];
    await pushOne(cg2Id, stub2, log2);
    ok(log2.some((l) => /jalur HTTP/.test(l)), 'falls back to the HTTP writer when the form will not take the list');
    const c2 = (await collections.spk().findOne({ _id: cg2Id }))!;
    ok(Boolean(c2.checkGo?.inspectionsFilledAt || c2.checkGo?.inspectionError), 'and the outcome is recorded either way');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('V. With the shipped switches, the SPK path is byte-for-byte the old one');
  {
    const stub = new StubSink();
    config.mergeIntoCheckGo = false; // as shipped
    const cg = await pushOne(await queuedCheckGo('B9203AB'), stub);
    ok(cg.state === 'confirmed' && !!cg.turboly.serviceOrderUrl, 'a Check & Go with no SPK still makes its own order');
    const spk = await pushOne(await queuedSpk('B9203AB'), stub);
    ok(stub.appends.length === 0, 'the SPK did NOT append — it behaves exactly as before');
    ok(stub.created.length === 2 && spk.turboly.serviceOrderUrl != null && !spk.turboly.mergedInto, 'it made its own Service Order');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('W. The real /checkgo document merges — its +30 min plan time is not an appointment');
  {
    const stub = new StubSink();
    config.mergeIntoCheckGo = false; // as shipped
    const spk = await pushOne(await queuedSpk('B9301AB'), stub);
    const cgId = await queuedCheckGo('B9301AB');
    const cgDoc = (await collections.spk().findOne({ _id: cgId }))!;
    ok(Date.parse(cgDoc.scheduledAt!) > Date.now() + 5 * 60_000, 'this Check & Go carries the same future plan time the live form stamps');
    const cg = await pushOne(cgId, stub);
    ok(stub.created.length === 1 && stub.appends.length === 1, 'it still merges: ONE Service Order for the car');
    ok(cg.turboly.mergedInto?.spkId === spk._id, 'joined the SPK order');

    // A visit booked for ANOTHER DAY is still its own order.
    const laterId = await queuedCheckGo('B9302AB');
    const spk2 = await pushOne(await queuedSpk('B9302AB'), stub);
    await collections.spk().updateOne({ _id: laterId }, { $set: { scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() } });
    const later = await pushOne(laterId, stub);
    ok(!later.turboly.mergedInto && later.turboly.serviceOrderUrl != null, 'a Check & Go booked for next week gets its own order');
    ok(spk2.turboly.serviceOrderUrl != null, '(and the SPK kept its own, as always)');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('X. Production shape: SPK, then a Cek n Go with a full 23-row checklist');
  {
    const stub = new StubSink();
    config.mergeIntoCheckGo = false; // exactly as shipped
    const spk = await pushOne(await queuedSpk('B2129UYM'), stub);
    const cgId = await queuedCheckGo('B2129UYM');
    // The real intake writes ~20-31 rows; SRO/TA17/26080160 carried 23.
    const items = Array.from({ length: 23 }, (_, i) => ({
      item: `${i + 1}. Item periksa`,
      hasil: i % 3 === 0 ? 'Bagus' : null,
      catatan: i % 3 === 0 ? null : 'perlu perhatian',
      feedback: null,
      inspected: true,
    }));
    await collections.spk().updateOne({ _id: cgId }, { $set: { 'checkGo.inspectionItems': items } });

    const log: string[] = [];
    const cg = await pushOne(cgId, stub, log);
    ok(stub.created.length === 1, 'ONE Service Order for the car — the SPK\'s');
    ok(cg.turboly.mergedInto?.spkId === spk._id && cg.state === 'confirmed', 'the Cek n Go joined it and confirmed');

    const sent = stub.appends.at(-1)!;
    ok(sent.target.inspections?.rows.length === 23, `all 23 checklist rows went to the form (got ${sent.target.inspections?.rows.length ?? 0})`);
    ok(sent.payload.serviceLines.some((l) => l.expectedSku === 'JASA-SPOOR' || l.expectedSku), 'the General Check line rides along with them');
    ok(sent.target.inspections?.rows.every((r) => r.description && r.notes), 'every row carries a description and a finding — no blank lines in the ERP');

    const after = (await collections.spk().findOne({ _id: cgId }))!;
    ok(!!after.checkGo?.inspectionsFilledAt, 'the document records the checklist as written');
    ok(!after.checkGo?.inspectionError, 'and no error was recorded');
    ok(!log.some((l) => /jalur HTTP/.test(l)), 'the HTTP writer — the one Turboly refused on a merged order — was NOT used');
    ok(log.some((l) => /inspection list terisi \(23 baris\) lewat form gabungan/.test(l)), 'the log says 23 rows went in with the merge');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('Y. Both submitted together → ONE pass, no five-minute wait');
  {
    // Turboly's CSA measured a visit going from ~2 minutes to ~7: the Cek n Go
    // was reached while its SPK was still queued, so it held and came back a
    // cron tick later. Taking the SPK first in the same pass removes the wait.
    await collections.spk().deleteMany({ state: 'queued' });
    const stub = new StubSink();
    config.mergeIntoCheckGo = false; // as shipped
    // Submitted seconds apart, both still queued — the real counter sequence.
    const spkId = await queuedSpk('B9401XY');
    const cgId = await queuedCheckGo('B9401XY');
    await collections.spk().updateOne({ _id: cgId }, { $set: { 'checkGo.inspectionItems': [{ item: 'Oli Mesin', hasil: 'Bagus', catatan: null, feedback: null, inspected: true }] } });

    const log: string[] = [];
    const sinks = new BranchSinks(async () => stub);
    await pushQueued(sinks, { workerId: 'w-test', log: (m) => log.push(m) });

    const spk = (await collections.spk().findOne({ _id: spkId }))!;
    const cg = (await collections.spk().findOne({ _id: cgId }))!;
    ok(spk.state === 'confirmed' && !!spk.turboly.serviceOrderUrl, 'the SPK was pushed first and got the order');
    ok(cg.state === 'confirmed' && cg.turboly.mergedInto?.spkId === spkId, 'the Cek n Go merged into it in the SAME pass');
    // Scoped to THIS car: the same pass legitimately picks up whatever else is
    // due (an earlier section's transient failure gets requeued here).
    const mine = stub.created.filter((p) => (p.vehiclePlateFull || p.vehicleRegistration || '').replace(/\s/g, '') === 'B9401XY');
    ok(mine.length === 1 && stub.appends.length === 1, `one Service Order for this car, one append (created=${mine.length}, appended=${stub.appends.length})`);
    ok(!log.some((l) => /menunggu/.test(l)), 'nothing waited — no five-minute hold');
    ok(cg.push.mergeHoldSince == null, 'and no waiting stamp was left behind');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('Z. The Cek n Go sent twice');
  {
    const stub = new StubSink();
    config.mergeIntoCheckGo = false; // as shipped
    const spk = await pushOne(await queuedSpk('B9501ZZ'), stub);

    // 1. The SAME submission replayed (offline queue, double tap): the intake
    //    dedupes on uploadId, so there is only ever ONE document.
    const first = await queuedCheckGo('B9501ZZ');
    const doc = (await collections.spk().findOne({ _id: first }))!;
    const replay = await collections.spk().findOne({ uploadId: doc.uploadId });
    ok(replay?._id === first, 'a replayed submission is the same document, not a second one');

    const cg1 = await pushOne(first, stub);
    ok(cg1.turboly.mergedInto?.spkId === spk._id, 'it merges into the SPK order');

    // 2. A genuinely NEW second Check & Go for the same car (staff re-entered it).
    const second = await queuedCheckGo('B9501ZZ');
    const cg2 = await pushOne(second, stub);
    ok(stub.created.length === 1, 'STILL one Service Order for the car — no third order appears');
    ok(cg2.turboly.mergedInto?.spkId === spk._id, 'the second Check & Go lands on the same order too');
    ok(stub.appends.length === 2, 'both were appended onto it');

    // 3. Pushing an already-merged document again changes nothing.
    stub.appendResult = { ok: true, serviceOrderNo: spk.turboly.serviceOrderNo, alreadyAppended: true };
    await collections.spk().updateOne({ _id: first }, { $set: { state: 'queued', 'push.nextAttemptAt': null } });
    const again = await pushOne(first, stub);
    ok(stub.created.length === 1, 'a re-push creates nothing');
    ok(again.turboly.mergedInto?.spkId === spk._id, 'and the document still points at the same order');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('AA. The checker inspects BEFORE the advisor writes the SPK');
  {
    // The counter does not always write the SPK first: the checker often has
    // the car on arrival. A backward-only window meant that visit could never
    // merge — it opened the two Service Orders this whole feature prevents.
    await collections.spk().deleteMany({ state: 'queued' });
    const stub = new StubSink();
    config.mergeIntoCheckGo = false; // as shipped
    const cgId = await queuedCheckGo('B9601AA');           // captured FIRST
    const spkId = await queuedSpk('B9601AA');              // SPK written after
    const cgDoc = (await collections.spk().findOne({ _id: cgId }))!;
    const spkDoc = (await collections.spk().findOne({ _id: spkId }))!;
    ok(Date.parse(spkDoc.createdAt) > Date.parse(cgDoc.createdAt), 'the SPK really was captured after the Check & Go');

    const log: string[] = [];
    const sinks = new BranchSinks(async () => stub);
    await pushQueued(sinks, { workerId: 'w-test', log: (m) => log.push(m) });

    const spk = (await collections.spk().findOne({ _id: spkId }))!;
    const cg = (await collections.spk().findOne({ _id: cgId }))!;
    const mine = stub.created.filter((p) => (p.vehiclePlateFull || p.vehicleRegistration || '').replace(/\s/g, '') === 'B9601AA');
    ok(mine.length === 1, `ONE Service Order for the car (got ${mine.length})`);
    ok(spk.turboly.serviceOrderUrl != null, 'the SPK still made the order, as always');
    ok(cg.turboly.mergedInto?.spkId === spkId, 'and the earlier Check & Go joined it instead of opening a second');
    config.mergeIntoCheckGo = true;
  }

  // ───────────────────────────────────────────────────────────────────────
  section('AB. A merge that already landed is never re-created, even with no readable token');
  {
    const stub = new StubSink();
    config.mergeIntoCheckGo = false;
    const spk = await pushOne(await queuedSpk('B9602AB'), stub);
    const cgId = await queuedCheckGo('B9602AB');
    // The sink reports "everything of mine is already on the order" — which is
    // what it now does when the SKUs are present but the token cannot be read
    // (an APPROVED order has no notes field, and Turboly overwrites the
    // General Check description). This must NOT become a second order.
    stub.appendResult = { ok: true, serviceOrderNo: spk.turboly.serviceOrderNo, alreadyAppended: true };
    const cg = await pushOne(cgId, stub);
    ok(stub.created.length === 1, 'no second Service Order was created');
    ok(cg.turboly.mergedInto?.spkId === spk._id && cg.state === 'confirmed', 'it is recorded as merged and confirmed');
    config.mergeIntoCheckGo = true;
  }

  {
    section('AC. a transient failure must not retry forever, nor hide a prior attempt');
    /**
     * B1562WNT and B2401MW were not stuck — they retried every ten minutes for
     * a day. A transient failure REFUNDS the attempt so a vendor outage cannot
     * strand an order, but unbounded that means attempt oscillates 0→1→0, the
     * requeue filter (attempt < MAX_ATTEMPTS) never excludes the document, and
     * a deterministic failure repeats until a person deletes it. The same
     * refund pinned attempt at 1, which is what the verify-before-recreate
     * guard tests — so the one check against a SECOND Service Order was off on
     * exactly the documents that had already run against Turboly many times.
     */
    const stub = new StubSink();
    stub.pushResult = { ok: false, serviceOrderNo: null, workOrderNo: null, verified: null, screenshotRef: null, serviceOrderUrl: null, approved: null, failureClass: 'transient', error: 'sesi ter-kick' } as never;
    const id = await queuedSpk('B9001TRN');
    const sinks = new BranchSinks(async () => stub);

    const seen: Array<{ attempt: number; transient: number; state: string }> = [];
    for (let pass = 1; pass <= 20; pass++) {
      // The cron's passage of time: a failed doc is only re-queued once its
      // 10-minute backoff is up.
      await collections.spk().updateOne({ _id: id }, { $set: { 'push.nextAttemptAt': new Date(Date.now() - 1000).toISOString() } });
      await pushQueued(sinks, { workerId: 'w-test', log: () => {} });
      const d = (await collections.spk().findOne({ _id: id }))!;
      seen.push({ attempt: d.push.attempt, transient: d.push.transientAttempts ?? 0, state: d.state });
    }

    const last = seen[seen.length - 1]!;
    // 12 refunded passes, then attempt still has to climb 1→5 before the
    // requeue filter drops it: ~16-17 passes in total, not 12. The number that
    // matters is not the total but that it STOPS — asserted on the tail below.
    ok(last.transient >= 12, `refund cap tercapai (${last.transient} kegagalan transient dihitung, tidak pernah direfund)`);
    ok(last.attempt >= 5, `attempt akhirnya naik sampai batas (${last.attempt}) — tidak lagi 0↔1 selamanya`);
    ok(last.state === 'failed', 'dokumen berhenti di failed, bukan antre lagi tiap 10 menit');
    // The proof it STOPPED: the last few passes did nothing at all.
    const tail = seen.slice(-3);
    ok(tail.every((t) => t.attempt === last.attempt && t.transient === last.transient),
       'tiga putaran terakhir tidak mengubah apa pun — loop-nya benar-benar berhenti');
    // ...and it did keep refunding for a while first, which is the outage case.
    ok(seen[3]!.attempt <= 1, `awalnya attempt tetap direfund (putaran 4: attempt=${seen[3]!.attempt}) — gangguan sesaat tidak menghukum dokumen`);

    // The guard: after a transient failure, the next pass MUST ask Turboly
    // before creating anything.
    ok(stub.verifyCalls > 0, `verify-before-recreate benar-benar dipanggil (${stub.verifyCalls}×) — dulu tidak pernah, karena attempt dipatok 1`);
  }

  await close();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
