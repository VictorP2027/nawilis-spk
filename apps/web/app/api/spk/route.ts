import { createHash } from 'node:crypto';
import { NextResponse, after } from 'next/server';
import { SpkIntakeInput, collections, assignMechanic } from '@spk/core';
import { db } from '../../../lib/db';
import { ingestSpk } from '../../../lib/ingest';
import { triggerTurbolyPush } from '../../../lib/triggerPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dispatch is an ACCELERATOR, never the source of truth: the SPK is already
 * `queued` in Mongo and push.yml's 5-minute cron pushes it either way. So it runs
 * AFTER the response is flushed — the operator gets their spkId without paying
 * the GitHub API round-trip (up to the helper's 4s abort cap when GitHub is slow).
 *
 * `after()` rather than a floating promise: on Vercel the invocation is frozen
 * the instant the response returns, so an un-awaited fetch would simply never be
 * sent and the SPK would silently fall back to the cron.
 */
function dispatchAfterResponse(spkId: string): void {
  after(async () => {
    try {
      await triggerTurbolyPush(spkId);
    } catch (e) {
      // triggerTurbolyPush swallows its own HTTP errors; this catches a dispatch
      // that throws outright. Log the spkId — the helper's own line carries the
      // status but not WHICH SPK just lost its head start.
      console.error(`push dispatch failed for ${spkId} — cron will pick it up: ${(e as Error).message ?? e}`);
    }
  });
}

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
        dispatchAfterResponse(result.spkId);
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
    .find(q, {
      projection: {
        customer: 1, vehicle: 1, jobLineSummary: 1, state: 1, branchCode: 1, capture: 1,
        'push.correlationToken': 1, 'push.lastError': 1, 'push.failureClass': 1, turboly: 1,
        // Whether a signature IMAGE exists — not whether one was declared.
        // `signatures.*.present` is set from the form's own flags and is true
        // for records that carry no ink at all (an API-created row, an operator
        // who typed a name without signing), so a thumbnail keyed off it points
        // at an image the server cannot serve and renders broken. This asks the
        // database the only question that matters: is there something to show.
        sigCust: { $toBool: { $ifNull: ['$signatures.menyerahkan.imageDataUrl', false] } },
        sigAdv: { $toBool: { $ifNull: ['$signatures.menerima.imageDataUrl', false] } },
      },
      sort: { createdAt: -1 },
      limit: 100,
    })
    .toArray();
  // The admin page re-asks every 10 seconds and the answer is usually the same
  // list, so an unchanged poll answers 304 with no body. Together with moving
  // the signature images out of this response, that is the difference between
  // 561 MB an hour and a few kilobytes.
  const body = JSON.stringify({ rows });
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
  }
  return new NextResponse(body, {
    headers: { 'content-type': 'application/json', ETag: etag, 'Cache-Control': 'no-cache' },
  });
}
