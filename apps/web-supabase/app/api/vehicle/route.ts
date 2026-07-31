import { NextResponse } from 'next/server';
import { findVehicleByVariants } from '@spk/core-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/vehicle?plate=B1234SZA — cross-branch history for the returning-customer fast path. */
export async function GET(req: Request): Promise<Response> {
  const plate = new URL(req.url).searchParams.get('plate');
  if (!plate) return NextResponse.json({ vehicle: null });
  const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vehicle = await findVehicleByVariants([key]);
  return NextResponse.json({ vehicle });
}
