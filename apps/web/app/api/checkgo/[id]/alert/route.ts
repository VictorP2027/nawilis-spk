import { NextResponse } from 'next/server';
import { collections, buildCheckGoAlert, type SpkDoc } from '@spk/core';
import { db } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The human gate in front of the WhatsApp send.
 *
 * Vercel cannot reach the WAHA gateway (it lives on a machine next to the
 * paired phone), so this route never sends anything. It does the two things a
 * send BUTTON needs:
 *
 *   GET  — the exact message that would go out, plus the profile it goes to,
 *          so staff approve what the customer will actually receive — not a
 *          summary of it.
 *   POST — stamp `checkGo.alert.mode = 'requested'`. The drainer
 *          (scripts/alerts-drain.mjs, running beside the gateway) sends ONLY
 *          docs carrying that stamp, so nothing reaches a customer without a
 *          click that had the full message on screen.
 */

async function load(id: string): Promise<{ doc: SpkDoc } | { error: Response }> {
  await db();
  const doc = (await collections.spk().findOne({ _id: id })) as SpkDoc | null;
  if (!doc) return { error: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  if (String(doc.docType) !== 'CHECK_AND_GO' || !doc.checkGo) {
    return { error: NextResponse.json({ error: 'not_checkgo', message: 'Dokumen ini bukan Check & Go' }, { status: 422 }) };
  }
  return { doc };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const r = await load(id);
  if ('error' in r) return r.error;
  const { doc } = r;
  try {
    const alert = buildCheckGoAlert(doc);
    return NextResponse.json({
      profile: {
        nama: doc.customer.nama,
        wa: doc.customer.waE164,
        plate: doc.vehicle.noPolisi.display || doc.vehicle.noPolisi.full,
        branch: doc.branchCode,
      },
      to: alert.to,
      text: alert.text,
      status: (doc.checkGo as { alert?: { mode?: string; at?: string } }).alert ?? null,
    });
  } catch (e) {
    // Usually an unusable number — the button should show WHY it cannot send.
    return NextResponse.json({ error: 'not_sendable', message: (e as Error).message }, { status: 422 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const r = await load(id);
  if ('error' in r) return r.error;
  const { doc } = r;

  const current = (doc.checkGo as { alert?: { mode?: string } }).alert?.mode ?? null;
  if (current === 'live') {
    // Already delivered. Re-sending is the drainer operator's call (--force),
    // not a thing a second button click should silently do.
    return NextResponse.json({ error: 'already_sent' }, { status: 409 });
  }

  let to: string;
  try {
    to = buildCheckGoAlert(doc).to; // validates now, so the queue never holds an unsendable request
  } catch (e) {
    return NextResponse.json({ error: 'not_sendable', message: (e as Error).message }, { status: 422 });
  }

  const body = (await req.json().catch(() => ({}))) as { by?: string; manual?: boolean };
  const by = body.by ?? 'flow-board';
  const at = new Date().toISOString();
  // Two ways to send: the gateway queue ('requested', delivered by the
  // watcher) or a human on plain WhatsApp Web ('manual' — the modal opened a
  // wa.me link with the full message pre-filled and someone pressed send
  // themselves). Manual is recorded as handled so the gateway never sends the
  // same customer a duplicate.
  const mode = body.manual ? 'manual' : 'requested';
  // The stamp is written CONDITIONALLY — the filter re-checks the doc's state
  // at write time, because two operators (or an operator and the drainer) can
  // act on the same stale row. A manual stamp may only land on a doc that is
  // unsent, failed, or carrying a legacy link-only stamp (mode 'manual'
  // without a sender); anything else means someone got there first. The
  // gateway path keeps its historical contract: anything but 'live'.
  const filter = body.manual
    ? {
        _id: id,
        $or: [
          { 'checkGo.alert': { $exists: false } },
          { 'checkGo.alert.mode': { $in: [null, 'failed'] } },
          { 'checkGo.alert.mode': 'manual', 'checkGo.alert.by': { $in: [null] } },
        ],
      }
    : { _id: id, 'checkGo.alert.mode': { $ne: 'live' } };
  const res = await collections.spk().updateOne(
    filter as never,
    { $set: { 'checkGo.alert': { mode, to, by, at }, updatedAt: at } },
  );
  if (res.matchedCount === 0) {
    return NextResponse.json(
      { error: 'conflict', message: 'Status berubah — dokumen ini sudah terkirim atau sedang antre. Muat ulang halaman.' },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, mode, to });
}
