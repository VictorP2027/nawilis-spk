import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/wa-status — the WhatsApp gateway's state, as last mirrored
 * into Mongo by the watcher (scripts/alerts-drain.mjs). Vercel cannot reach
 * the gateway machine; Mongo is the bridge. When the session needs pairing,
 * `qrDataUrl` carries the actual QR so anyone can pair the sender phone from
 * the browser — no Docker, no terminal, no access to the gateway machine.
 */
export async function GET(): Promise<Response> {
  await db();
  const doc = await getDb().collection('wa_gateway').findOne({ _id: 'status' } as never);
  if (!doc) return NextResponse.json({ known: false });
  const d = doc as unknown as { session: string; status: Record<string, unknown>; qrDataUrl: string | null; updatedAt: string };
  return NextResponse.json({
    known: true,
    session: d.session,
    status: d.status,
    qrDataUrl: d.qrDataUrl ?? null,
    updatedAt: d.updatedAt,
    // Older than two watcher ticks = the watcher itself is probably down,
    // which the console should say instead of showing stale green.
    stale: Date.now() - Date.parse(d.updatedAt) > 90_000,
  });
}
