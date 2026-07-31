import { connect, close, collections, transition, loadMirror } from '@spk/core';
import { buildTurbolyPayload } from '@spk/core/turboly';
import { BranchSinks } from './sessions.js';
import { config } from './config.js';

/**
 * Redis-free ONE-SHOT push — for testing the Turboly auto-feed and for
 * scheduled runs. Pushes every `queued` SPK (or a single --id=<spkId>) into
 * Turboly, then verifies. The always-on worker (index.ts) does the same via
 * BullMQ; this is the same logic without the queue, so it needs no Redis.
 *
 *   npm run push:once            # push all queued
 *   npm run push:once -- --id=01K...   # push just one
 */
const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

async function main(): Promise<void> {
  const onlyId = process.argv.find((a) => a.startsWith('--id='))?.slice(5);
  await connect(config.mongoUri, config.mongoDb);
  const branchSinks = new BranchSinks();

  const filter = onlyId ? { _id: onlyId } : { state: 'queued' as const };
  const docs = await collections.spk().find(filter).limit(25).toArray();
  console.log(`push-once: mode=${config.pushMode} base=${config.turbolyBaseUrl} — ${docs.length} candidate(s)`);

  for (const doc of docs) {
    if (doc.state !== 'queued') { console.log(`· skip ${doc._id} (state=${doc.state})`); continue; }
    const epoch = doc.push.lease.epoch + 1;
    const leaseExpiresAt = Date.now() + config.leaseTtlMs;
    const claimed = await transition(doc._id, 'queued', 'pushing', {
      push: { ...doc.push, attempt: doc.push.attempt + 1, lease: { workerId: 'push-once', epoch, expiresAt: new Date(leaseExpiresAt).toISOString() } },
    });
    if (!claimed) { console.log(`· skip ${doc._id} (lost CAS)`); continue; }

    try {
      const mirror = await loadMirror(claimed.branchCode);
      if (!mirror.store) throw new Error(`store ${claimed.branchCode} not in mirror (run seed:turboly)`);
      const advisor = mirror.advisorByName.get(norm(claimed.signatures.menerima.namaJelas));
      if (!advisor) throw new Error(`advisor "${claimed.signatures.menerima.namaJelas}" not in mirror`);
      const payload = buildTurbolyPayload({ doc: claimed, store: mirror.store, serviceProducts: mirror.serviceProducts, serviceAdvisor: advisor, salesperson: advisor });

      const res = await branchSinks.withSink(claimed.branchCode, (sink) =>
        sink.pushServiceOrder(payload, { workerId: 'push-once', epoch, approve: config.approveAfterSave, leaseExpiresAt }),
      );
      if (!res.ok) throw new Error(`push failed [${res.failureClass}]: ${res.error}`);
      await transition(doc._id, 'pushing', 'pushed', { turboly: { ...claimed.turboly, serviceOrderNo: res.serviceOrderNo } });
      console.log(`✓ ${doc._id} → Service Order ${res.serviceOrderNo}`);

      const v = await branchSinks.withSink(claimed.branchCode, (sink) =>
        sink.verifyByToken({ ...claimed, turboly: { ...claimed.turboly, serviceOrderNo: res.serviceOrderNo } }),
      );
      if (v.found) {
        await transition(doc._id, 'pushed', 'confirmed', {
          turboly: { ...claimed.turboly, serviceOrderNo: v.serviceOrderNo, readback: { matchedOn: ['reference_token'], lineCount: v.lineCount, lineSkus: v.lineSkus, km: v.km } },
        });
        console.log(`  ✓ verified → confirmed`);
      } else {
        console.log(`  ⚠ not verified (left in 'pushed')`);
      }
    } catch (e) {
      await transition(doc._id, 'pushing', 'failed', {
        push: { ...claimed.push, lastError: String((e as Error).message ?? e), nextAttemptAt: new Date(Date.now() + 60_000).toISOString() },
      }).catch(() => {});
      console.log(`✗ ${doc._id}: ${(e as Error).message ?? e}`);
    }
  }

  await branchSinks.dispose();
  await close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
