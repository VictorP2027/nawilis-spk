import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/vehicle?plate=B1234SZA — cross-branch history for the returning-customer fast path. */
export async function GET(req: Request): Promise<Response> {
  await db();
  const plate = new URL(req.url).searchParams.get('plate');
  if (!plate) return NextResponse.json({ vehicle: null });
  const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vehicle = await collections.vehicles().findOne({ plateVariants: key });
  return NextResponse.json({ vehicle });
}
