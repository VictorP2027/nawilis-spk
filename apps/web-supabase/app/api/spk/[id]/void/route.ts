import { NextResponse } from 'next/server';
import { voidBeforeAssignment } from '@spk/core-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/spk/:id/void — customer declined the work before assignment. Never pushed. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { by?: string; reason?: string };
  const updated = await voidBeforeAssignment(id, body.by ?? 'unknown', body.reason ?? 'declined');
  if (!updated) return NextResponse.json({ error: 'not_voidable' }, { status: 409 });
  return NextResponse.json({ spkId: updated._id, state: updated.state });
}
