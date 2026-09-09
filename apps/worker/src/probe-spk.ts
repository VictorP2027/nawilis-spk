import { connect, close, collections, canonPhoneKey } from '@spk/core';
import { config } from './config.js';

/**
 * READ-ONLY: why did this SPK fail?
 *
 * Prints only what is needed to reason about a push failure — the identity the
 * intake captured, the vehicle, and the push history. No Turboly session, no
 * writes, and no customer contact details beyond what the failure turns on.
 *
 *   node --import tsx apps/worker/src/probe-spk.ts --plate=B63YNA
 *   node --import tsx apps/worker/src/probe-spk.ts --phone=+6583050688   (any spelling; matched on the canonical key)
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const PLATE = (arg('plate') ?? '').toUpperCase().replace(/\s/g, '');
const PHONE = canonPhoneKey(arg('phone') ?? '');

async function main(): Promise<void> {
  if (!PLATE && !PHONE) { console.error('butuh --plate=B63YNA atau --phone=+62…'); process.exit(1); }
  await connect(config.mongoUri, config.mongoDb);
  const filter = PLATE
    ? { $or: [{ 'vehicle.noPolisi.full': PLATE }, { 'vehicle.noPolisi.display': PLATE }] }
    : { 'customer.phoneKey': PHONE };
  const docs = await collections.spk().find(filter as never).sort({ createdAt: -1 }).limit(5).toArray();
  console.log(`db=${config.mongoDb} ${PLATE ? `plat=${PLATE}` : `phoneKey=${PHONE.slice(0, 3)}…${PHONE.slice(-3)}`} → ${docs.length} dokumen\n`);
  for (const d of docs as Array<Record<string, any>>) {
    console.log(`— ${d._id}  ${d.docType}  state=${d.state}  cabang=${d.branchCode}`);
    console.log(`  dibuat        : ${d.createdAt ?? '-'}  (capture ${d.capture?.mode ?? '-'})`);
    console.log(`  customer.nama : "${d.customer?.nama ?? ''}"`);
    console.log(`  waE164        : ${d.customer?.waE164 ? String(d.customer.waE164).slice(0, 6) + '…' + String(d.customer.waE164).slice(-3) : '(kosong)'}`);
    console.log(`  turbolyCustomerId : ${d.customer?.turbolyCustomerId ?? '(TIDAK ADA)'}`);
    console.log(`  plat          : full="${d.vehicle?.noPolisi?.full ?? ''}" display="${d.vehicle?.noPolisi?.display ?? ''}"`);
    console.log(`  merk/tipe     : "${d.vehicle?.merkNormalized ?? d.vehicle?.merkRaw ?? ''}" / "${d.vehicle?.tipeNormalized ?? ''}"  kind=${d.vehicle?.kind ?? '-'}`);
    console.log(`  push.attempt  : ${d.push?.attempt ?? 0}  transient=${d.push?.transientAttempts ?? 0}  class=${d.push?.failureClass ?? '-'}`);
    console.log(`  push.error    : ${d.push?.error ?? '-'}`);
    console.log(`  turboly.SO    : ${d.turboly?.serviceOrderNo ?? '(belum)'}`);
    console.log('');
  }
  process.exit(0);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
