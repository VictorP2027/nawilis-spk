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
  const url = new URL(req.url);
  const make = (url.searchParams.get('make') ?? '').trim().toUpperCase();
  // 'car' | 'motorcycle' narrows to that type's models — four make names exist
  // as BOTH brands (HONDA/BMW/SUZUKI/BAJAJ), so the untyped list mixes Civics
  // with Vario scooters. No kind (or no typed map yet) = the mixed list.
  const kind = url.searchParams.get('kind');
  const doc = await getDb().collection<{ _id: string; byMake: Record<string, string[]>; byMakeCar?: Record<string, string[]>; byMakeMotor?: Record<string, string[]> }>('vehicle_models_map').findOne({ _id: 'byMake' });
  if (!doc) return NextResponse.json({ models: [], known: false });
  const typed = kind === 'car' ? doc.byMakeCar : kind === 'motorcycle' ? doc.byMakeMotor : undefined;
  const map = typed ?? doc.byMake;
  const key = Object.keys(map).find((k) => k.toUpperCase() === make);
  // `known` answers "does this MAKE exist" — from the union map, so an empty
  // typed list (a bike-only make asked for cars) does not read as a typo.
  const unionKey = Object.keys(doc.byMake).find((k) => k.toUpperCase() === make);
  return NextResponse.json({ models: key ? map[key] : [], known: !!unionKey });
}
