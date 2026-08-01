import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/vehicle-models?make=GWM — the models Turboly's vehicle form offers for
 * that make (harvested from /vehicles/new). Feeds the Tipe datalist so staff pick
 * a model exactly as Turboly spells it — a mismatch fails new-vehicle creation.
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const make = (new URL(req.url).searchParams.get('make') ?? '').trim().toUpperCase();
  const doc = await getDb().collection<{ _id: string; byMake: Record<string, string[]> }>('vehicle_models_map').findOne({ _id: 'byMake' });
  if (!doc) return NextResponse.json({ models: [], known: false });
  const key = Object.keys(doc.byMake).find((k) => k.toUpperCase() === make);
  return NextResponse.json({ models: key ? doc.byMake[key] : [], known: !!key });
}
