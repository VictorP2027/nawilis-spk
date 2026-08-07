import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mechanics?branch=NWL-BKS — the people Turboly will accept as a Work
 * Order line assignee, from the tb_mechanics mirror.
 *
 * This used to return advisors too, on the assumption that Turboly takes either.
 * It does not: assigning an advisor is refused outright and the whole WO is
 * rejected ("Service Item Line 1: Assignee can't be blank"). Only people the
 * sync flagged isMechanic — Turboly's own per-store mechanic list — qualify.
 *
 * Cross-branch is refused too ("Mechanic Cross Store feature is not enabled"),
 * so a branch filter here is exact: no tenant-wide fallback, because a mechanic
 * with no store cannot be assigned anywhere.
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const branch = url.searchParams.get('branch');

  const q: Record<string, unknown> = { $or: [{ isMechanic: true }, { role: /mechanic/i }] };
  if (branch) q.storeCode = branch;

  const rows = await collections.tbMechanics().find(q).sort({ name: 1 }).toArray();

  return NextResponse.json({
    // `role` is the person's PRIMARY role, and sending it as the label made a
    // "pilih mekanik" list read "(advisor)" next to people Turboly itself lists
    // as mechanics — DEVI FITRIANI and DIAN SETYAWATI at Bekasi appear in both
    // of Turboly's store-user lookups, verified live. Everyone in this response
    // is assignable by construction, so the label says what they can DO here,
    // and `alsoAdvisor` marks the dual-role people instead of mislabelling them.
    mechanics: rows.map((m) => ({
      code: m.mechanicCode,
      name: m.name,
      role: m.role,
      label: m.role === 'mechanic' ? 'mekanik' : 'mekanik + advisor',
      alsoAdvisor: m.role !== 'mechanic',
      storeCode: m.storeCode,
    })),
    // The board shows this when the list is empty: without it an operator sees
    // a blank picker and no reason for it.
    note: rows.length === 0 && branch ? `Belum ada mekanik ter-sync untuk ${branch} — jalankan sync-catalogs` : undefined,
  });
}
