import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The admin console's "hapus semua" — OPERATIONAL data only.
 *
 * What may be wiped: the documents the branches produced (spk, their events,
 * the flow queue, the vehicle history, the dead letters). What may never be
 * wiped from here: the reference mirrors — tb_stores, tb_mechanics,
 * tb_products, service catalogs, SKU maps. Losing those is not a clean slate,
 * it is an outage (service_sku_map is human-confirmed and no sync rebuilds it).
 *
 * GET  — the backup: every purgeable collection as one JSON download. The
 *        console fetches this FIRST and saves it to the admin's machine.
 * POST — the deletion, only with the typed confirmation {confirm:"HAPUS"}.
 */
// `vehicles` is deliberately NOT here: it is the branch's memory of people —
// plates, owners, visit counts — the thing that makes a returning customer
// fast. Wiping documents and queues is a clean slate; wiping who your
// customers are is amnesia.
const PURGEABLE = ['spk', 'spk_events', 'flow_jobs', 'turboly_docs', 'push_dlq'] as const;

export async function GET(): Promise<Response> {
  await db();
  const d = getDb();
  const dump: Record<string, unknown[]> = {};
  for (const name of PURGEABLE) dump[name] = await d.collection(name).find({}).toArray();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return new Response(JSON.stringify({ takenAt: new Date().toISOString(), db: d.databaseName, collections: dump }, null, 1), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="spk-backup-${stamp}.json"`,
      'cache-control': 'no-store',
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  await db();
  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== 'HAPUS') {
    return NextResponse.json({ error: 'confirm_required', message: 'Kirim {confirm:"HAPUS"} — dan unduh backup dulu.' }, { status: 400 });
  }
  const d = getDb();
  const deleted: Record<string, number> = {};
  for (const name of PURGEABLE) {
    deleted[name] = (await d.collection(name).deleteMany({})).deletedCount;
  }
  return NextResponse.json({ ok: true, deleted });
}
