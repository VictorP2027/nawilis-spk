import { NextResponse } from 'next/server';
import { assignMechanic } from '@spk/core';
import { db } from '../../../../../lib/db';
import { triggerTurbolyPush } from '../../../../../lib/triggerPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/spk/:id/assign — the gate that releases a parked SPK to the Turboly
 * push queue. Called when the mechanic scans the printed QR job ticket at job
 * start (via: ticket_scan) or from the ops console (via: console).
 *
 * Body: { mechanicCode, by, via?, lineNos?, waktuMinutes? }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await db();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    mechanicCode?: string;
    by?: string;
    via?: 'ticket_scan' | 'console';
    lineNos?: number[];
    waktuMinutes?: number;
  };
  if (!body.mechanicCode || !body.by) {
    return NextResponse.json({ error: 'mechanicCode and by are required' }, { status: 400 });
  }
  const updated = await assignMechanic(id, {
    mechanicCode: body.mechanicCode,
    by: body.by,
    via: body.via ?? 'ticket_scan',
    lineNos: body.lineNos,
    waktuMinutes: body.waktuMinutes,
  });
  if (!updated) {
    return NextResponse.json({ error: 'not_assignable', hint: 'SPK not in awaiting_assignment (already assigned, declined, or not yet validated)' }, { status: 409 });
  }
  // Released to the push queue → kick the GitHub Actions push NOW (instant),
  // instead of waiting for the 5-min cron. Best-effort; the cron is the fallback.
  if (updated.state === 'queued') {
    await triggerTurbolyPush(updated._id);
  }
  return NextResponse.json({ spkId: updated._id, state: updated.state, queuedForTurboly: updated.state === 'queued' });
}
