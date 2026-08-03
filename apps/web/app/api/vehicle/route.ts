import { NextResponse } from 'next/server';
import { collections, localPhone } from '@spk/core';
import { turbolyVehicleByPlate } from '../../../lib/turbolyLookup';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/vehicle?plate=B1234SZA — returning-customer fast path.
 * TURBOLY FIRST for identity (the ERP knows the car and its owner inline);
 * the local vehicles cache supplements history (lastKm/lastSeen/visits) and
 * carries the whole answer when Turboly is unreachable.
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const plate = new URL(req.url).searchParams.get('plate');
  if (!plate) return NextResponse.json({ vehicle: null });
  const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cached = await collections.vehicles().findOne({ plateVariants: key });

  // 1) LIVE Turboly: vehicle attrs + owner (customer_name/phone come inline).
  try {
    const tv = await turbolyVehicleByPlate(key);
    if (tv) {
      return NextResponse.json({
        vehicle: {
          plateFull: key,
          merk: tv.vehicle_make ?? null,
          tipe: tv.vehicle_model ?? null,
          tahun: tv.year != null && tv.year !== '' ? Number(tv.year) : null,
          warna: tv.color ?? null,
          lastKm: cached?.lastKm ?? null,
          lastSeenAt: cached?.lastSeenAt ?? null,
          lastBranch: cached?.lastBranch ?? null,
          visitCount: cached?.visitCount ?? 0,
        },
        customer: tv.customer_name
          ? { nama: tv.customer_name, wa: tv.customer_phone ? localPhone(String(tv.customer_phone)) : null, alamat: null }
          : null,
        source: 'turboly',
      });
    }
  } catch { /* Turboly unreachable — fall through to Mongo */ }

  // 2) ELSE — local cache + last SPK (covers downtime and un-pushed captures).
  const lastSpk = await collections
    .spk()
    .findOne({ 'vehicle.plateVariants': key }, { sort: { createdAt: -1 }, projection: { customer: 1 } });
  const customer = lastSpk?.customer
    ? { nama: lastSpk.customer.nama, wa: lastSpk.customer.waE164 ? localPhone(lastSpk.customer.waE164) : null, alamat: lastSpk.customer.alamat ?? null }
    : null;
  return NextResponse.json({ vehicle: cached, customer, source: 'mongo' });
}
