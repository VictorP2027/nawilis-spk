import { NextResponse } from 'next/server';
import { getSpk, deleteSpk } from '@spk/core-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/spk/:id — full record. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const doc = await getSpk(id);
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(doc);
}

/** DELETE /api/spk/:id — remove a record and its events/claims. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const deleted = await deleteSpk(id);
  return NextResponse.json({ deleted });
}
