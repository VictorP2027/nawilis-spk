import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/spk/:id — full record (for a detail view). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await db();
  const { id } = await ctx.params;
  const doc = await collections.spk().findOne({ _id: id });
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(doc);
}

/**
 * DELETE /api/spk/:id — remove a record and its events/claims.
 * Safe here because Turboly push is manual/local. In production a confirmed
 * (pushed) record should be voided in Turboly first, not silently deleted.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await db();
  const { id } = await ctx.params;
  const res = await collections.spk().deleteOne({ _id: id });
  await collections.spkEvents().deleteMany({ spkId: id }).catch(() => {});
  await collections.turbolyDocs().deleteMany({ spkId: id }).catch(() => {});
  await collections.dlq().deleteMany({ spkId: id }).catch(() => {});
  return NextResponse.json({ deleted: res.deletedCount });
}
