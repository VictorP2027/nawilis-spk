/**
 * End-to-end integration test against a real (in-memory) MongoDB.
 *
 * Exercises the full pipeline with a STUB Turboly (no browser / no real tenant):
 *   ingest → validate → awaiting_assignment → assign(mechanic) → queued →
 *   [worker] CAS pushing + claim + payload + stub push → pushed →
 *   [real Verifier] read-back → confirmed
 *
 * Plus the critical safety invariants: the assignment gate, no-double-push
 * (concurrent CAS + unique claim), uploadId idempotency, and validation blocks.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  connect, close, ensureIndexes, collections,
  buildSpkDoc, resolveSkus, loadMirror, validateLayer1, validateLayer2,
  transition, assignMechanic, voidBeforeAssignment, claimId, correlationToken,
  type SpkIntakeInputT, type SpkDoc,
} from '@spk/core';
import { buildTurbolyPayload, type ServiceOrderSink, type PushContext, type PushResult, type VerifyResult, type TurbolyServiceOrderPayload } from '@spk/core/turboly';
import { Verifier } from '../apps/worker/src/verifier.ts';
import { BranchSinks } from '../apps/worker/src/sessions.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(s: string): void { console.log(`\n── ${s} ──`); }

/** In-memory Turboly that records what it was asked to create. */
class StubSink implements ServiceOrderSink {
  readonly mode = 'rpa' as const;
  public created: TurbolyServiceOrderPayload[] = [];
  public failNext: PushResult['failureClass'] | null = null;
  async pushServiceOrder(payload: TurbolyServiceOrderPayload, _ctx: PushContext): Promise<PushResult> {
    if (this.failNext) { const fc = this.failNext; this.failNext = null; return { ok: false, serviceOrderNo: null, workOrderNo: null, verified: null, failureClass: fc, error: `stub ${fc}` }; }
    this.created.push(payload);
    const no = `SBO/BKS/${260700000 + this.created.length}`;
    return { ok: true, serviceOrderNo: no, workOrderNo: null, verified: null, screenshotRef: null };
  }
  async verifyByToken(doc: SpkDoc): Promise<VerifyResult> {
    const created = this.created.find((p) => p.correlationToken === doc.push.correlationToken);
    if (!created) return { found: false, serviceOrderNo: null, store: null, lineCount: null, lineSkus: [], km: null };
    return { found: true, serviceOrderNo: doc.turboly.serviceOrderNo, store: created.storeName, lineCount: created.serviceLines.length + created.sparepartLines.length, lineSkus: created.serviceLines.map((l) => l.expectedSku), km: Number(created.odometer) };
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

/**
 * Replicates the web ingest pipeline against core (build→validate→park).
 * `autoConfirm` simulates the operator clearing CONFIRM flags in the review
 * console (needs_review → validated → awaiting_assignment). Blocks always hold.
 */
async function ingest(input: SpkIntakeInputT, autoConfirm = true): Promise<{ spkId: string; state: string; rules: string[]; blocked: boolean }> {
  let doc = buildSpkDoc(input);
  doc.uploadId = input.uploadId;
  if (input.serviceAdvisorName) doc.signatures.menerima.namaJelas = input.serviceAdvisorName;
  const mirror = await loadMirror(doc.branchCode);
  doc = resolveSkus(doc, mirror.skuFor);
  const prior = await collections.vehicles().findOne({ plateVariants: { $in: doc.vehicle.plateVariants } });
  const l1 = validateLayer1(doc, prior);
  await collections.spk().insertOne(doc);
  await transition(doc._id, 'captured', 'extracted');
  await transition(doc._id, 'extracted', 'needs_review');
  const l2 = validateLayer2(doc, { mirror, serviceAdvisorName: input.serviceAdvisorName, salespersonName: input.salespersonName ?? input.serviceAdvisorName, planServiceDate: null, planServiceTime: null });
  const rules = [...l1.findings, ...l2.findings].map((f) => f.rule);
  const blocked = l1.blocked || l2.blocked;
  const needsConfirm = l1.needsConfirm || l2.needsConfirm;
  if (blocked || (needsConfirm && !autoConfirm)) return { spkId: doc._id, state: 'needs_review', rules, blocked };
  await transition(doc._id, 'needs_review', 'validated');
  const parked = await transition(doc._id, 'validated', 'awaiting_assignment');
  return { spkId: doc._id, state: parked?.state ?? 'validated', rules, blocked: false };
}

/** Replicates the push worker's core create step (no BullMQ/Redis). */
async function pushOnce(spkId: string, sink: StubSink, workerId = 'w-test'): Promise<SpkDoc | null> {
  const doc = await collections.spk().findOne({ _id: spkId });
  if (!doc) return null;
  const epoch = doc.push.lease.epoch + 1;
  const claimed = await transition(spkId, 'queued', 'pushing', {
    push: { ...doc.push, attempt: doc.push.attempt + 1, claimedAt: new Date().toISOString(), lease: { workerId, epoch, expiresAt: new Date(Date.now() + 600_000).toISOString() } },
  });
  if (!claimed) return null; // lost the CAS
  const cId = claimId(spkId, 'order');
  await collections.turbolyDocs().insertOne({ _id: cId, spkId, phase: 'order', correlationToken: claimed.push.correlationToken, claimedBy: workerId, epoch, claimedAt: new Date().toISOString(), committedAt: null, turbolyDocNo: null });
  const mirror = await loadMirror(claimed.branchCode);
  const advisor = mirror.advisorByName.get('RINA S')!;
  const payload = buildTurbolyPayload({ doc: claimed, store: mirror.store!, serviceProducts: mirror.serviceProducts, serviceAdvisor: advisor, salesperson: advisor });
  const res = await sink.pushServiceOrder(payload, { workerId, epoch, approve: true, leaseExpiresAt: Date.now() + 600_000 });
  if (!res.ok) { await collections.turbolyDocs().deleteOne({ _id: cId, committedAt: null }); await transition(spkId, 'pushing', 'failed', { push: { ...claimed.push, failureClass: res.failureClass, nextAttemptAt: new Date().toISOString() } }); return null; }
  await collections.turbolyDocs().updateOne({ _id: cId }, { $set: { committedAt: new Date().toISOString(), turbolyDocNo: res.serviceOrderNo } });
  return transition(spkId, 'pushing', 'pushed', { turboly: { ...claimed.turboly, serviceOrderNo: res.serviceOrderNo } });
}

async function seedMirror(): Promise<void> {
  const now = new Date().toISOString();
  await collections.tbStores().insertOne({ _id: 'NWL-BKS', turbolyStoreId: '7', turbolyStoreName: 'Nawilis Bekasi', syncedAt: now });
  await collections.tbServiceProducts().insertOne({ _id: 'JASA-SPOOR', sku: 'JASA-SPOOR', name: 'Spooring', type: 'service', taxCode: 'PPN', price: 350000, masterDurationMin: 30, storeCode: null, syncedAt: now });
  await collections.tbMechanics().insertOne({ _id: 'M001', mechanicCode: 'M001', name: 'Rina S', storeCode: null, role: 'advisor', syncedAt: now });
  await collections.serviceSkuMap().insertOne({ _id: '*:SPOORING', branchCode: null, serviceCode: 'SPOORING', sku: 'JASA-SPOOR', matchScore: 1, confirmed: true, updatedAt: now });
  // A returning vehicle so the happy path isn't a first-visit (which always
  // CONFIRMs its odometer) and so the KM-monotonicity test has history to compare.
  await collections.vehicles().insertOne({ _id: 'veh_B1743BKA', plateFull: 'B1743BKA', plateVariants: ['B1743BKA'], merk: 'TOYOTA', tipe: 'AVANZA', tahun: 2019, warna: 'Silver', lastKm: 40000, lastSeenAt: now, lastBranch: 'NWL-BKS', visitCount: 3, customerRefs: [] });
}

async function main(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  console.log(`MongoDB (in-memory) at ${uri}`);
  await connect(uri, 'spktest');
  await ensureIndexes();
  await seedMirror();

  section('Happy path: ingest → park → assign → push → verify → confirmed');
  const r = await ingest(intake());
  ok(r.state === 'awaiting_assignment', `ingest parks at awaiting_assignment (got ${r.state})`);
  let doc = (await collections.spk().findOne({ _id: r.spkId }))!;
  ok(doc.jobLines[0]!.turbolySku === 'JASA-SPOOR', 'SKU resolved from mirror');
  ok(doc.push.correlationToken === correlationToken(doc._id), 'correlation token set');

  // The gate: not queued until a mechanic is assigned.
  ok(doc.state === 'awaiting_assignment' && doc.state !== 'queued', 'NOT queued before assignment (the gate holds)');
  const assigned = await assignMechanic(r.spkId, { mechanicCode: 'M001', by: 'test', via: 'ticket_scan' });
  ok(assigned?.state === 'queued', `assign → queued (got ${assigned?.state})`);
  ok(assigned?.jobLines[0]!.mk.mechanicCode === 'M001', 'mechanic written onto job line');
  ok(assigned?.assignment?.via === 'ticket_scan', 'assignment recorded');

  const stub = new StubSink();
  const pushed = await pushOnce(r.spkId, stub);
  ok(pushed?.state === 'pushed', `push → pushed (got ${pushed?.state})`);
  ok(stub.created.length === 1, 'stub Turboly received exactly one Service Order');
  const p = stub.created[0]!;
  ok(p.storeName === 'Nawilis Bekasi', 'payload store name correct');
  ok(p.referenceNumber === doc.push.correlationToken, 'REFERENCE NUMBER = correlation token');
  ok(p.odometer === '45230', 'odometer is the integer, not the formatted string');
  ok(p.serviceLines.length === 1 && p.serviceLines[0]!.expectedSku === 'JASA-SPOOR', 'service line carries the resolved SKU');
  ok(p.serviceAdvisorName === 'Rina S' && p.salespersonName === 'Rina S', 'advisor + salesperson resolved');
  ok(pushed?.turboly.serviceOrderNo?.startsWith('SBO/BKS/'), `SO number captured (${pushed?.turboly.serviceOrderNo})`);

  // Real Verifier (injected stub) does the pushed → confirmed transition.
  const verifier = new Verifier(new BranchSinks(async () => stub));
  await verifier.process({ spkId: r.spkId, branchCode: 'NWL-BKS' });
  doc = (await collections.spk().findOne({ _id: r.spkId }))!;
  ok(doc.state === 'confirmed', `verify → confirmed (got ${doc.state})`);
  ok(doc.turboly.readback.matchedOn.includes('reference_token'), 'read-back matched on reference token');

  section('No double-push: concurrent CAS claim');
  const r2 = await ingest(intake({ uploadId: 'u-dbl', vehicle: { noPolisi: 'B5678CD', merk: 'Honda', tipe: 'Brio', tahun: 2021, warna: 'Merah', km: '10.000' } }));
  await assignMechanic(r2.spkId, { mechanicCode: 'M001', by: 'test', via: 'console' });
  const [a, b] = await Promise.all([
    transition(r2.spkId, 'queued', 'pushing', { push: { ...(await collections.spk().findOne({ _id: r2.spkId }))!.push, lease: { workerId: 'wA', epoch: 1, expiresAt: null } } }),
    transition(r2.spkId, 'queued', 'pushing', { push: { ...(await collections.spk().findOne({ _id: r2.spkId }))!.push, lease: { workerId: 'wB', epoch: 1, expiresAt: null } } }),
  ]);
  ok([a, b].filter(Boolean).length === 1, 'exactly one worker wins the CAS claim (no double-push)');

  section('No double-push: unique claim table');
  const cid = claimId(r2.spkId, 'order');
  const base = { spkId: r2.spkId, phase: 'order' as const, correlationToken: correlationToken(r2.spkId), claimedBy: 'x', epoch: 1, claimedAt: new Date().toISOString(), committedAt: null, turbolyDocNo: null };
  const claimResults = await Promise.allSettled([
    collections.turbolyDocs().insertOne({ _id: cid, ...base }),
    collections.turbolyDocs().insertOne({ _id: cid, ...base }),
  ]);
  ok(claimResults.filter((x) => x.status === 'fulfilled').length === 1, 'unique claim _id: exactly one insert succeeds');

  section('Idempotency: duplicate uploadId rejected');
  const dupResults = await Promise.allSettled([
    collections.spk().insertOne({ ...buildSpkDoc(intake({ uploadId: 'u-idem' })), uploadId: 'u-idem' }),
    collections.spk().insertOne({ ...buildSpkDoc(intake({ uploadId: 'u-idem' })), uploadId: 'u-idem' }),
  ]);
  ok(dupResults.filter((x) => x.status === 'fulfilled').length === 1, 'duplicate uploadId: exactly one insert succeeds');

  section('Validation blocks');
  const noSku = await ingest(intake({ uploadId: 'u-nosku', jobLines: [{ serviceCode: 'ENGINE_FLUSH', ordered: true, qty: 1, keterangan: null, quotedPrice: 200000 }] }));
  ok(noSku.state === 'needs_review' && noSku.blocked, 'unmapped SKU (ENGINE_FLUSH) → blocked in needs_review');

  const badAdvisor = await ingest(intake({ uploadId: 'u-noadv', serviceAdvisorName: 'Unknown Person', signatures: { menyerahkanPresent: true, menyerahkanInkDensity: null, menerimaPresent: true, menerimaNamaJelas: 'Unknown Person' } }));
  ok(badAdvisor.blocked, 'advisor not in Turboly mirror → blocked');

  section('KM monotonicity on returning vehicle (CONFIRM, not silent)');
  const lower = await ingest(intake({ uploadId: 'u-km', vehicle: { noPolisi: 'B1743BKA', merk: 'Toyota', tipe: 'Avanza', tahun: 2019, warna: 'Silver', km: '30.000' } }), false);
  ok(lower.state === 'needs_review', 'KM lower than history → held for confirmation, not auto-passed');
  ok(lower.rules.includes('KM_MONOTONIC'), 'KM_MONOTONIC flag raised (not silently accepted)');

  section('Declined estimate never pushed');
  const dec = await ingest(intake({ uploadId: 'u-dec', vehicle: { noPolisi: 'B9999ZZ', merk: 'Suzuki', tipe: 'Ertiga', tahun: 2020, warna: 'Hitam', km: '22.000' } }));
  const voided = await voidBeforeAssignment(dec.spkId, 'test', 'customer declined');
  ok(voided?.state === 'voided', 'awaiting_assignment → voided (declined, never queued)');

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);

  await close();
  await mongod.stop();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
