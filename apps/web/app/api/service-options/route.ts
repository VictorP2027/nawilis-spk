import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/service-options — per SPK service code, the Turboly variants + default,
 * so the form can offer a dropdown per job (defaults to the default; operator can change).
 */
export async function GET(): Promise<Response> {
  await db();
  const rows = await getDb()
    .collection<{ _id: string; defaultSku: string; options: { sku: string; label: string }[] }>('service_options')
    .find({})
    .toArray();
  const services: Record<string, { defaultSku: string; options: { sku: string; label: string }[] }> = {};
  for (const r of rows) services[r._id] = { defaultSku: r.defaultSku, options: r.options };
  return NextResponse.json({ services });
}
