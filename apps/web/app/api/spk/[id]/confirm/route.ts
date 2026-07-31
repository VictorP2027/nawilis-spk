import { NextResponse } from 'next/server';
import { confirmReview } from '../../../../../lib/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/spk/:id/confirm — operator resolved review flags; park for assignment. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { by?: string };
  const updated = await confirmReview(id, body.by ?? 'unknown');
  if (!updated) return NextResponse.json({ error: 'not_confirmable' }, { status: 409 });
  return NextResponse.json({ spkId: updated._id, state: updated.state });
}
