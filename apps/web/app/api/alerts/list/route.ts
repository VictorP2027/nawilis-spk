import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/alerts/list?q=&status=&limit= — the WhatsApp send ledger.
 *
 * The flow board answers "what needs doing now" and forgets cards after its
 * 14-day window; this answers "what happened, ever": every Check & Go with
 * its send status, so a dispute ("customer says nothing arrived") is settled
 * by lookup, not memory. Status values mirror the stamp contract:
 * live (gateway/robot delivered) · manual (a human sent it on WhatsApp Web) ·
 * requested (queued, waiting for a sender) · failed (unsendable, e.g. bad
 * number) · none (never sent).
 */

const MODES = ['live', 'manual', 'requested', 'failed'] as const;

interface LedgerAlert {
  mode?: string;
  to?: string;
  by?: string;
  at?: string;
  provider?: string;
  error?: string;
}

export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const status = url.searchParams.get('status') ?? '';
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 300));

  const query: Record<string, unknown> = {
    docType: 'CHECK_AND_GO',
    state: { $nin: ['voided', 'superseded'] },
  };
  // Equality-null matches BOTH missing and explicit-null mode — the same
  // bucketing the chip aggregation's $ifNull uses, so chips and rows agree.
  if (status === 'none') query['checkGo.alert.mode'] = null;
  else if ((MODES as readonly string[]).includes(status)) query['checkGo.alert.mode'] = status;
  if (q !== '') {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or: Array<Record<string, unknown>> = [
      { 'vehicle.noPolisi.display': rx },
      { 'vehicle.noPolisi.full': rx },
      { 'customer.nama': rx },
      { 'customer.waE164': rx },
    ];
    // waE164 is mixed-shape ('+62812…' when parsed, '0812…' fallback), so a
    // phone-shaped query also matches customer.phoneKey — the canonical
    // digits-only key with 62/0 prefixes stripped — making '0812…', '+62812…'
    // and '812…' all find the same customer.
    const digits = q.replace(/[\s\-().+]/g, '');
    if (/^\d{5,}$/.test(digits)) {
      let key = digits;
      if (key.startsWith('62')) key = key.slice(2);
      if (key.startsWith('0')) key = key.slice(1);
      or.push({ 'customer.phoneKey': new RegExp('^' + key) });
    }
    query.$or = or;
  }

  const docs = await collections.spk()
    .find(query, {
      projection: {
        createdAt: 1, branchCode: 1,
        'customer.nama': 1, 'customer.waE164': 1,
        'vehicle.noPolisi.display': 1, 'vehicle.noPolisi.full': 1,
        'checkGo.alert': 1,
      },
    })
    .sort({ createdAt: -1 })
    .limit(limit + 1) // one extra: its presence is the exact truncation signal
    .toArray();
  const truncated = docs.length > limit;

  const rows = docs.slice(0, limit).map((d) => {
    const doc = d as unknown as {
      _id: string; createdAt: string; branchCode: string;
      customer?: { nama?: string; waE164?: string };
      vehicle?: { noPolisi?: { display?: string; full?: string } };
      checkGo?: { alert?: LedgerAlert };
    };
    const alert = doc.checkGo?.alert ?? null;
    return {
      id: doc._id,
      createdAt: doc.createdAt,
      branch: doc.branchCode,
      plate: doc.vehicle?.noPolisi?.display || doc.vehicle?.noPolisi?.full || '—',
      customer: doc.customer?.nama ?? '—',
      wa: doc.customer?.waE164 ?? null,
      mode: alert?.mode ?? null,
      at: alert?.at ?? null,
      by: alert?.by ?? null,
      provider: alert?.provider ?? null,
      error: alert?.error ?? null,
    };
  });

  // Chip counts cover the WHOLE ledger (same q, ignoring the status filter),
  // so the chips stay stable while one of them is active.
  const countQuery = { ...query };
  delete countQuery['checkGo.alert.mode'];
  const grouped = await collections.spk().aggregate([
    { $match: countQuery },
    { $group: { _id: { $ifNull: ['$checkGo.alert.mode', 'none'] }, n: { $sum: 1 } } },
  ]).toArray();
  const counts: Record<string, number> = { live: 0, manual: 0, requested: 0, failed: 0, none: 0 };
  for (const g of grouped as Array<{ _id: string; n: number }>) counts[g._id] = g.n;

  return NextResponse.json({ rows, counts, truncated });
}
