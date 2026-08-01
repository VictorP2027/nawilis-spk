import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/advisors?branch=NWL-BKS — the real service advisors for a branch,
 * synced from Turboly (seed-advisors.mjs). Feeds the form's advisor dropdown so
 * staff pick a real advisor instead of free-typing (no typos → correct push).
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const branch = new URL(req.url).searchParams.get('branch');
  const q = branch ? { role: 'advisor', $or: [{ storeCode: branch }, { storeCode: null }] } : { role: 'advisor' };
  const rows = await collections.tbMechanics().find(q).sort({ name: 1 }).toArray();
  return NextResponse.json({ advisors: rows.map((m) => ({ code: m.mechanicCode, name: m.name })) });
}
