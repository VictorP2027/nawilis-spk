import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { loadBranchList } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/branches — the branch picker's list: the compiled-in branches plus
 * any added since the last deploy.
 *
 * The forms fall back to their own compiled-in copy when this fails, so a
 * failure here costs a newly-added branch, never the ability to write an SPK.
 * ETag'd like the SPK list: the answer changes a few times a year.
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const branches = (await loadBranchList()).map((b) => ({ code: b.code, name: b.name, type: b.type }));
  const body = JSON.stringify({ branches });
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
  }
  return new NextResponse(body, {
    headers: { 'content-type': 'application/json', ETag: etag, 'Cache-Control': 'no-cache' },
  });
}
