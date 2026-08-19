import { connect, close, collections, loadMirror, type SpkDoc } from '@spk/core';
import {
  buildTurbolyPayload, planFromNowWib, formatDateWib, formatTimeWib,
  inspectionRowsFromCheckGo, type AppendTarget,
} from '@spk/core/turboly';
import { BranchSinks } from './sessions.js';
import { config } from './config.js';

/**
 * REPAIR ONE MERGE — `--id=<spkId>`.
 *
 * A merged document is `confirmed` and the push runner will never look at it
 * again (confirmed only leads to amend_pending, which nothing consumes). That
 * is right for the normal case and wrong for a HALF-finished merge: on
 * SRO/TA17/26080160 a Check & Go's notes and token landed on the SPK's order
 * while its General Check line was silently dropped by Turboly, and its
 * inspection list was refused by the HTTP writer.
 *
 * This re-runs exactly the merge step for one document against the order it is
 * already attached to. It is safe to run twice: appendLinesToServiceOrder adds
 * only the lines whose SKU is not already on the order, proves each row took a
 * product before saving, and proves the SKUs are on the page afterwards.
 *
 *   node --import tsx apps/worker/src/merge-repair.ts --id=01M09Q7B6E66CRH8AWF27A1QD5
 */
async function main(): Promise<void> {
  const id = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  if (!id) {
    console.error('merge-repair: butuh --id=<spkId>');
    process.exitCode = 1;
    return;
  }
  await connect(config.mongoUri, config.mongoDb);
  let sinks: BranchSinks | undefined;
  try {
    const doc = (await collections.spk().findOne({ _id: id })) as SpkDoc | null;
    if (!doc) throw new Error(`dokumen ${id} tidak ada`);
    const url = doc.turboly?.mergedInto?.serviceOrderUrl ?? null;
    if (!url) throw new Error(`dokumen ${id} tidak digabung ke SO manapun (turboly.mergedInto kosong) — tidak ada yang diperbaiki`);

    // withProductSkus: without it every goods SKU looks like a service, and the
    // repair would type a sparepart into the SERVICE picker — which finds
    // nothing, leaves the row blank, and Turboly discards it silently.
    const mirror = await loadMirror(doc.branchCode, { withProductSkus: true });
    if (!mirror.store) throw new Error(`store ${doc.branchCode} tidak ada di mirror`);
    const norm = (s: string): string => s.trim().toLowerCase();
    const typedAdvisor = (doc.signatures?.menerima?.namaJelas ?? '').trim();
    const advisor =
      mirror.advisorByName.get(norm(typedAdvisor)) ??
      { _id: 'unmatched', mechanicCode: 'unmatched', name: typedAdvisor, storeCode: null, role: 'advisor' as const, syncedAt: '' };
    const typedSales = (doc.salespersonName ?? '').trim() || typedAdvisor;
    const salesperson =
      mirror.salespersonByName.get(norm(typedSales)) ??
      { _id: 'unmatched', mechanicCode: 'unmatched', name: typedSales, storeCode: null, role: 'salesperson' as const, syncedAt: '' };
    const sched = doc.scheduledAt && Date.parse(doc.scheduledAt) > Date.now() + 5 * 60_000 ? doc.scheduledAt : null;
    const plan = sched ? { date: formatDateWib(sched), time: formatTimeWib(sched) } : planFromNowWib(30);
    const payload = buildTurbolyPayload({
      doc, store: mirror.store, serviceProducts: mirror.serviceProducts, productSkus: mirror.productSkus,
      serviceAdvisor: advisor, salesperson, planServiceDate: plan.date, planServiceTime: plan.time,
    });

    const items = (doc as { checkGo?: { inspectionItems?: Array<{ item: string; hasil?: string | null; catatan: string | null; feedback?: string | null; inspected?: boolean }> } }).checkGo?.inspectionItems ?? [];
    const target: AppendTarget = {
      serviceOrderUrl: url,
      expectedPlate: (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, ''),
      spkToken: doc.push.correlationToken,
      inspections: String(doc.docType) === 'CHECK_AND_GO' && items.length ? { category: 'NAWILIS CHECK & GO', rows: inspectionRowsFromCheckGo(items) } : null,
    };
    console.log(`merge-repair: ${id} (${doc.docType}) → ${url}`);
    console.log(`  baris yang seharusnya ada: ${[...payload.serviceLines, ...payload.sparepartLines].map((l) => l.expectedSku).join(', ') || '(tidak ada)'}`);
    console.log(`  daftar inspeksi: ${target.inspections?.rows.length ?? 0} baris`);

    sinks = new BranchSinks();
    const res = await sinks.withSink(doc.branchCode, (sink) =>
      sink.appendLinesToServiceOrder
        ? sink.appendLinesToServiceOrder(target, payload, { workerId: 'merge-repair', epoch: doc.push.lease.epoch, approve: false, leaseExpiresAt: Date.now() + config.leaseTtlMs })
        : Promise.resolve({ ok: false as const, serviceOrderNo: null, failureClass: 'structural' as const, error: 'sink ini tidak bisa mengedit SO' }),
    );

    if (!res.ok) {
      console.error(`merge-repair: GAGAL — ${res.error ?? '?'}`);
      process.exitCode = 1;
      return;
    }
    if (typeof res.inspectionsWritten === 'number' && res.inspectionsWritten > 0) {
      await collections.spk().updateOne({ _id: id }, { $set: { 'checkGo.inspectionsFilledAt': new Date().toISOString() }, $unset: { 'checkGo.inspectionError': '' } });
      console.log(`  ✓ daftar inspeksi terisi (${res.inspectionsWritten} baris)`);
    }
    console.log(`merge-repair: SELESAI — SO ${res.serviceOrderNo ?? '?'}${res.alreadyAppended ? ' (semua baris memang sudah ada)' : ''}`);
    await sinks.dispose().catch(() => {});
    await close();
    // Explicit: the live Playwright browser keeps the event loop alive, so a
    // SUCCESSFUL repair would otherwise hold the turboly-push lane — and every
    // customer order behind it — until the 60-minute job timeout.
    process.exit(0);
  } catch (e) {
    console.error(`merge-repair: ${(e as Error).message ?? e}`);
    process.exitCode = 1;
  } finally {
    await sinks?.dispose().catch(() => {});
    await close();
  }
}

void main();
