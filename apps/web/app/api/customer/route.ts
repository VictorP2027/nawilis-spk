import { NextResponse } from 'next/server';
import { collections, canonPhoneKey, localPhone } from '@spk/core';
import { turbolyCustomersByPhone, turbolyDebugProbe } from '../../../lib/turbolyLookup';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/customer?phone=0223456789 — phone-first lookup (phone = identity pkey).
 * Returns the person (from their most recent SPK) and their distinct vehicles,
 * newest first, so the form can auto-populate and offer a car picker.
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const key = canonPhoneKey(new URL(req.url).searchParams.get('phone') ?? '');
  if (new URL(req.url).searchParams.get('debug') === '2') {
    return NextResponse.json({ probe: await turbolyDebugProbe(key) });
  }
  if (key.length < 8) return NextResponse.json({ customer: null, vehicles: [] });

  // Match stored forms: new docs have phoneKey; older ones only waE164 variants.
  const docs = await collections
    .spk()
    .find(
      { $or: [{ 'customer.phoneKey': key }, { 'customer.waE164': { $in: [key, '0' + key, '62' + key, '+62' + key] } }] },
      { sort: { createdAt: -1 }, limit: 25, projection: { customer: 1, vehicle: 1, createdAt: 1 } },
    )
    .toArray();
  if (docs.length === 0) {
    // Not in our DB — LIVE Turboly lookup (customers who never used this form).
    try {
      const hits = await turbolyCustomersByPhone(key);
      const c = hits[0];
      if (c) {
        const vs = (c.vehicles ?? [])
          .map((v) => {
            const r = v as Record<string, unknown>;
            return {
              plate: String(r.registration ?? ''),
              merk: (r.vehicle_make ?? null) as string | null,
              tipe: (r.vehicle_model ?? null) as string | null,
              tahun: r.year != null && r.year !== '' ? Number(r.year) : null,
              warna: (r.color ?? null) as string | null,
            };
          })
          .filter((v) => v.plate);
        return NextResponse.json({
          customer: {
            nama: c.name,
            wa: c.phone ? localPhone(String(c.phone)) : null,
            alamat: (c.address ?? '').replace(/, Indonesia$/, '') || null,
          },
          vehicles: vs,
          source: 'turboly',
        });
      }
    } catch (e) {
      /* Turboly unreachable — behave like a miss (error visible with ?debug=1) */
      if (new URL(req.url).searchParams.get('debug')) {
        return NextResponse.json({ customer: null, vehicles: [], turbolyError: String(e) });
      }
    }
    return NextResponse.json({ customer: null, vehicles: [] });
  }

  // The ORIGINAL registration owns the name: oldest record with this phone key
  // (a later visit typed as a different name must not rename the person).
  const original = await collections
    .spk()
    .findOne(
      { $or: [{ 'customer.phoneKey': key }, { 'customer.waE164': { $in: [key, '0' + key, '62' + key, '+62' + key] } }] },
      { sort: { createdAt: 1 }, projection: { customer: 1 } },
    );
  const latest = docs[0]!;
  const customer = {
    nama: original?.customer.nama ?? latest.customer.nama,
    wa: (original?.customer.waE164 ?? latest.customer.waE164) ? localPhone(original?.customer.waE164 ?? latest.customer.waE164 ?? '') : null,
    alamat: latest.customer.alamat ?? original?.customer.alamat ?? null,
  };
  // Distinct vehicles, newest first.
  const seen = new Set<string>();
  const vehicles: Array<{ plate: string; merk: string | null; tipe: string | null; tahun: number | null; warna: string | null }> = [];
  for (const d of docs) {
    const plate = d.vehicle?.noPolisi?.full;
    if (!plate || seen.has(plate)) continue;
    seen.add(plate);
    vehicles.push({
      plate,
      merk: d.vehicle.merkNormalized ?? d.vehicle.merkRaw ?? null,
      tipe: d.vehicle.tipeNormalized ?? null,
      tahun: d.vehicle.tahun ?? null,
      warna: d.vehicle.warna ?? null,
    });
  }
  return NextResponse.json({ customer, vehicles });
}
