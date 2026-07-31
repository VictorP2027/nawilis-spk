import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/summary — pipeline health snapshot for the ops dashboard. */
export async function GET(): Promise<Response> {
  await db();

  const byState = await collections
    .spk()
    .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$state', n: { $sum: 1 } } }])
    .toArray();

  const byBranch = await collections
    .spk()
    .aggregate<{ _id: string; captured: number; confirmed: number }>([
      { $group: { _id: '$branchCode', captured: { $sum: 1 }, confirmed: { $sum: { $cond: [{ $eq: ['$state', 'confirmed'] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  const dlqOpen = await collections.dlq().countDocuments({ resolvedAt: null });
  const degradation = await collections.degradation().findOne({ _id: 'degradation' });
  const lastRecon = await collections.reconRuns().find({}, { sort: { ranAt: -1 }, limit: 1 }).toArray();

  // Age-in-state alerts (queued>10m, pushing>5m, needs_review>4h, manual>4h).
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const [queuedStale, pushingStale, reviewStale, manualStale] = await Promise.all([
    collections.spk().countDocuments({ state: 'queued', updatedAt: { $lt: iso(10 * 60_000) } }),
    collections.spk().countDocuments({ state: 'pushing', updatedAt: { $lt: iso(5 * 60_000) } }),
    collections.spk().countDocuments({ state: 'needs_review', updatedAt: { $lt: iso(4 * 3600_000) } }),
    collections.spk().countDocuments({ state: 'manual_intervention', updatedAt: { $lt: iso(4 * 3600_000) } }),
  ]);

  return NextResponse.json({
    byState: Object.fromEntries(byState.map((s) => [s._id, s.n])),
    byBranch,
    dlqOpen,
    degradation: degradation ?? { rung: 0 },
    lastRecon: lastRecon[0] ?? null,
    ageAlerts: { queuedStale, pushingStale, reviewStale, manualStale },
  });
}
