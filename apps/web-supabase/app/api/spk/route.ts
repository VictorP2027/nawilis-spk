import { NextResponse } from 'next/server';
import { SpkIntakeInput, ingestSpk, listSpk } from '@spk/core-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/spk — ingest one SPK into Supabase. */
export async function POST(req: Request): Promise<Response> {
  const json = await req.json().catch(() => null);
  const parsed = SpkIntakeInput.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await ingestSpk(parsed.data);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    console.error('ingest error', e);
    return NextResponse.json({ error: 'ingest_failed', message: (e as Error).message }, { status: 500 });
  }
}

/** GET /api/spk?branch=&state=&plate= — list from Supabase. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rows = await listSpk({
    branch: url.searchParams.get('branch'),
    state: url.searchParams.get('state'),
    plate: url.searchParams.get('plate'),
  });
  return NextResponse.json({ rows });
}
