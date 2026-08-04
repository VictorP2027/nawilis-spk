import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mechanics?branch=NWL-BKS[&role=mechanic] — assignable people for the
 * flow board's Work Order picker, from the tb_mechanics mirror (synced from
 * Turboly). Both mechanics AND advisors are returned (Turboly accepts either as
 * a WO line assignee); mechanics are listed first. Optional ?role= narrows to
 * one role. Branch matching mirrors /api/advisors: the branch's own people plus
 * tenant-wide entries (storeCode null).
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const branch = url.searchParams.get('branch');
  const roleParam = url.searchParams.get('role');

  const roleOr = roleParam
    ? [{ role: new RegExp(roleParam.replace(/[^a-z]/gi, ''), 'i') }]
    : [{ role: /mechanic/i }, { role: /advisor/i }];

  const q: Record<string, unknown> = { $or: roleOr };
  if (branch) q.$and = [{ $or: [{ storeCode: branch }, { storeCode: null }] }];

  const rows = await collections.tbMechanics().find(q).sort({ name: 1 }).toArray();

  // Mechanics before advisors (the picker's primary use is WO assignment).
  const rank = (role: string | null): number => (/mechanic/i.test(role ?? '') ? 0 : 1);
  rows.sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name));

  return NextResponse.json({
    mechanics: rows.map((m) => ({ code: m.mechanicCode, name: m.name, role: m.role, storeCode: m.storeCode })),
  });
}
