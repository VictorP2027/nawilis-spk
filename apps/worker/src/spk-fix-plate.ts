import { connect, close, collections, transition, parsePlate, plateVariants } from '@spk/core';
import { config } from './config.js';

/**
 * ONE-OFF: correct a mistyped plate on an SPK that has NOT been pushed.
 *
 * There is no edit path for a captured SPK — the API is GET and DELETE only —
 * and the alternative to this is re-typing the whole intake at the counter.
 * This rewrites ONLY the plate (and the derived fields that must stay in step
 * with it), then puts the document back on the queue the same way the board's
 * "Coba lagi" button does.
 *
 * REFUSES, loudly, when the document already has a Service Order or is not in
 * `failed`. That is the line that matters: a Service Order cannot be deleted,
 * so a plate must never move underneath one — the order would then describe a
 * different car than the one it was raised for.
 *
 *   node --import tsx apps/worker/src/spk-fix-plate.ts \
 *     --spk=01M1R0966BSJN092XMKBGJY99V --plate=A29SJP [--apply]
 *
 * Without --apply it only prints what it would change.
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const SPK = (arg('spk') ?? '').trim();
const NEW = (arg('plate') ?? '').trim().toUpperCase();
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  if (!SPK || !NEW) { console.error('butuh --spk=<id> --plate=<PLAT BARU>'); process.exit(1); }
  await connect(config.mongoUri, config.mongoDb);
  const doc = await collections.spk().findOne({ _id: SPK } as never) as Record<string, any> | null;
  if (!doc) { console.error(`✗ SPK ${SPK} tidak ada`); process.exit(1); }

  const so = doc.turboly?.serviceOrderNo ?? null;
  console.log(`SPK      : ${SPK}`);
  console.log(`customer : "${doc.customer?.nama ?? ''}"  cabang=${doc.branchCode}`);
  console.log(`kendaraan: ${doc.vehicle?.merkNormalized ?? '-'} ${doc.vehicle?.tipeNormalized ?? '-'}`);
  console.log(`state    : ${doc.state}   SO: ${so ?? '(belum)'}`);
  console.log(`plat     : "${doc.vehicle?.noPolisi?.full}" → "${NEW}"`);

  // The two refusals. Neither is recoverable if crossed.
  if (so) { console.error(`\n✗ DITOLAK: SPK ini sudah punya Service Order ${so}. Plat tidak boleh dipindah di bawah SO — perbaiki di Turboly.`); process.exit(1); }
  if (doc.state !== 'failed') { console.error(`\n✗ DITOLAK: state="${doc.state}", hanya SPK "failed" yang boleh diperbaiki di sini.`); process.exit(1); }

  const p = parsePlate(NEW);
  if (!p.ok) { console.error(`\n✗ DITOLAK: "${NEW}" tidak terbaca sebagai nomor polisi.`); process.exit(1); }

  const set = {
    'vehicle.noPolisi.full': p.full,
    'vehicle.noPolisi.display': p.display,
    'vehicle.noPolisi.correctionsApplied': p.correctionsApplied,
    'vehicle.plateVariants': plateVariants(p.full),
  };
  console.log(`\nakan diubah:`);
  for (const [k, v] of Object.entries(set)) console.log(`  ${k.padEnd(38)} = ${JSON.stringify(v)}`);

  if (!APPLY) { console.log('\n— UJI COBA: tidak ada yang ditulis. Tambahkan --apply untuk menerapkan. —'); process.exit(0); }

  await collections.spk().updateOne({ _id: SPK } as never, { $set: set } as never);
  console.log(`\n✓ plat diperbaiki`);

  // Back on the queue, exactly as the board's "Coba lagi" does it.
  const back = await transition(SPK, 'failed', 'queued', {
    'push.lastError': null,
    'push.failureClass': null,
    'push.attempt': 0,
    'push.nextAttemptAt': new Date().toISOString(),
  } as never);
  console.log(back ? `✓ antre lagi (state=${back.state})` : '⚠ gagal mengantre ulang — tekan "Coba lagi" di papan');
  process.exit(0);
}
main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
