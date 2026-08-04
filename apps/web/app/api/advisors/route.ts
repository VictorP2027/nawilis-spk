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
  const scope = branch ? { $or: [{ storeCode: branch }, { storeCode: null }] } : {};
  const rows = await collections.tbMechanics().find({ ...scope, role: { $in: ['advisor', 'salesperson'] } }).sort({ name: 1 }).toArray();
  const advisors = rows.filter((m) => m.role === 'advisor').map((m) => ({ code: m.mechanicCode, name: m.name }));
  // Turboly's Salesperson select is a separate list at some stores: people with
  // role salesperson, plus advisors known to appear in both lists.
  const salespeople = rows
    .filter((m) => m.role === 'salesperson' || (m as { alsoSalesperson?: boolean }).alsoSalesperson)
    .map((m) => ({ code: m.mechanicCode, name: m.name }));
  return NextResponse.json({ advisors, salespeople });
}
