import { NextResponse } from 'next/server';
import { transition } from '@spk/core';
import { db } from '../../../../../lib/db';
import { triggerTurbolyPush } from '../../../../../lib/triggerPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/spk/:id/retry — requeue a failed SPK and kick the push now.
 * Used after fixing the cause (e.g. adding a missing make/model in Turboly).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await db();
  const { id } = await ctx.params;
  // Dot-paths: reset only the retry-relevant fields, preserving correlationToken/lease.
  const updated = await transition(id, 'failed', 'queued', {
    'push.lastError': null,
    'push.failureClass': null,
    'push.attempt': 0,
    'push.nextAttemptAt': new Date().toISOString(),
  } as never);
  if (!updated) return NextResponse.json({ error: 'not_retryable', hint: 'SPK is not in failed state' }, { status: 409 });
  await triggerTurbolyPush(id);
  return NextResponse.json({ spkId: id, state: updated.state });
}
