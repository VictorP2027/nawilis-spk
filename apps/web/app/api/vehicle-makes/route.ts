import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/vehicle-makes — Turboly's real vehicle-make catalog (harvested from
 * /vehicles/new). Feeds the Merk datalist so staff pick a make Turboly accepts —
 * a made-up make ("fewfew") can't create a vehicle and would fail the push.
 */
export async function GET(): Promise<Response> {
  await db();
  const doc = await getDb().collection<{ _id: string; list: string[] }>('vehicle_makes').findOne({ _id: 'makes' });
  return NextResponse.json({ makes: doc?.list ?? [] });
}
