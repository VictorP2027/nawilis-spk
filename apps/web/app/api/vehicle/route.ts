import { NextResponse } from 'next/server';
import { collections } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/vehicle?plate=B1234SZA — cross-branch history for the returning-customer fast path. */
export async function GET(req: Request): Promise<Response> {
  await db();
  const plate = new URL(req.url).searchParams.get('plate');
  if (!plate) return NextResponse.json({ vehicle: null });
  const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vehicle = await collections.vehicles().findOne({ plateVariants: key });
  // Returning-customer prefill: the person from this plate's most recent SPK.
  const lastSpk = await collections
    .spk()
    .findOne({ 'vehicle.plateVariants': key }, { sort: { createdAt: -1 }, projection: { customer: 1 } });
  const local = (p: string) => { const d = p.replace(/\D/g, ''); return d.startsWith('62') ? '0' + d.slice(2) : d; };
  const customer = lastSpk?.customer
    ? { nama: lastSpk.customer.nama, wa: lastSpk.customer.waE164 ? local(lastSpk.customer.waE164) : null, alamat: lastSpk.customer.alamat ?? null }
    : null;
  return NextResponse.json({ vehicle, customer });
}
