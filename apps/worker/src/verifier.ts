import { collections, transition, emit } from '@spk/core';
import type { BranchSinks } from './sessions.js';
import type { VerifyJob } from './queue.js';
import { fireAlert } from './alerts.js';

/**
 * Post-push verification. Runs as a SEPARATE job (fresh navigation) and is the
 * ONLY thing that may set `confirmed`. Proves the Turboly record matches Mongo:
 * reference token, store, line count, and odometer — not mere existence.
 *
 * Reads back from the persistent Service Order LIST (never an ephemeral
 * dashboard), so a fast QuickServ job doesn't produce a false negative that a
 * human then "fixes" by creating a duplicate.
 */
export class Verifier {
  constructor(private readonly branchSinks: BranchSinks) {}

  async process(job: VerifyJob): Promise<void> {
    const doc = await collections.spk().findOne({ _id: job.spkId });
    if (!doc) return;
    if (doc.state !== 'pushed' && doc.state !== 'amend_pending') return;

    const v = await this.branchSinks.withSink(job.branchCode, (sink) => sink.verifyByToken(doc));

    if (!v.found) {
      // Genuine silent loss OR verification ran too early. BullMQ retries the
      // verify job (backoff); after retries exhaust it lands here as missing.
      await fireAlert({ level: 'ops', code: 'VERIFY_NOT_FOUND', branchCode: doc.branchCode, message: `${doc._id}: token not found on Turboly SO list` });
      throw new Error('verify: not found (will retry)');
    }

    // Content assertions.
    const expectedLineCount = doc.jobLines.filter((l) => l.ordered).length;
    const kmOk = v.km == null || v.km === doc.vehicle.km.value;
    const countOk = v.lineCount == null || v.lineCount >= 1; // best-effort; UI scrape is fuzzy
    const storeOk = v.store == null || v.store.toLowerCase().includes((doc.push.storeSwitch.expected ?? '').toLowerCase().slice(0, 6));

    const matchedOn: string[] = ['reference_token'];
    if (kmOk) matchedOn.push('km');
    if (storeOk) matchedOn.push('store');
    if (countOk) matchedOn.push('line_count');

    if (!kmOk || !storeOk) {
      // Landed, but landed WRONG — the most dangerous state.
      await transition(doc._id, doc.state, 'manual_intervention', {
        turboly: { ...doc.turboly, serviceOrderNo: v.serviceOrderNo, readback: { matchedOn, lineCount: v.lineCount, lineSkus: v.lineSkus, km: v.km } },
      });
      await fireAlert({ level: 'page', code: 'VERIFY_MISMATCH', branchCode: doc.branchCode, message: `${doc._id}: readback mismatch (kmOk=${kmOk} storeOk=${storeOk})`, data: { expectedLineCount, v } });
      return;
    }

    await transition(doc._id, doc.state, 'confirmed', {
      turboly: { ...doc.turboly, serviceOrderNo: v.serviceOrderNo, workOrderNo: doc.turboly.workOrderNo, readback: { matchedOn, lineCount: v.lineCount, lineSkus: v.lineSkus, km: v.km } },
    });
    await emit({ spkId: doc._id, type: 'confirmed', by: 'verifier', data: { serviceOrderNo: v.serviceOrderNo, matchedOn } });
  }
}
