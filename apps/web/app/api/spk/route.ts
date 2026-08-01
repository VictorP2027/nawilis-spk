import { NextResponse } from 'next/server';
import { SpkIntakeInput, collections, assignMechanic } from '@spk/core';
import { db } from '../../../lib/db';
import { ingestSpk } from '../../../lib/ingest';
import { triggerTurbolyPush } from '../../../lib/triggerPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/spk — ingest one SPK (typed or photo-extracted). */
export async function POST(req: Request): Promise<Response> {
  const json = await req.json().catch(() => null) as { directPush?: boolean } | null;
  const parsed = SpkIntakeInput.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = await ingestSpk(parsed.data);
    // Direct push (default): skip the "awaiting assignment" gate — release straight
    // to the Turboly queue and kick the push now. Send {directPush:false} to hold it
    // in awaiting_assignment instead (e.g. a quote that shouldn't be pushed yet).
    if (json?.directPush !== false && !result.duplicate && result.state === 'awaiting_assignment') {
      const released = await assignMechanic(result.spkId, { mechanicCode: 'UNASSIGNED', by: 'form-direct', via: 'console' });
      if (released?.state === 'queued') {
        result.state = 'queued';
        await triggerTurbolyPush(result.spkId);
      }
    }
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    console.error('ingest error', e);
    return NextResponse.json({ error: 'ingest_failed', message: (e as Error).message }, { status: 500 });
  }
}

/** GET /api/spk?branch=NWL-BKS&state=awaiting_assignment — list for the branch queue. */
export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const branch = url.searchParams.get('branch');
  const state = url.searchParams.get('state');
  const plate = url.searchParams.get('plate');
  const q: Record<string, unknown> = {};
  if (branch) q.branchCode = branch;
  if (state) q.state = state;
  if (plate) q['vehicle.plateVariants'] = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rows = await collections
    .spk()
    .find(q, { projection: { customer: 1, vehicle: 1, jobLineSummary: 1, state: 1, branchCode: 1, capture: 1, 'push.correlationToken': 1, 'push.lastError': 1, 'push.failureClass': 1, turboly: 1 }, sort: { createdAt: -1 }, limit: 100 })
    .toArray();
  return NextResponse.json({ rows });
}
