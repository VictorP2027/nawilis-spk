import { NextResponse } from 'next/server';
import { archiveFlowCard } from '@spk/core';
import { db } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/spk/:id/archive — hide a card from the flow board. Reason is mandatory: it is the only record of why. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await db();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return NextResponse.json({ error: 'reason_required' }, { status: 400 });
  const archived = await archiveFlowCard(id, reason, body.by ?? 'flow-board');
  if (!archived) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
