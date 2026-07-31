import { NextResponse } from 'next/server';
import { summarize } from '@spk/core-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/summary — pipeline health snapshot from Supabase. */
export async function GET(): Promise<Response> {
  return NextResponse.json(await summarize());
}
