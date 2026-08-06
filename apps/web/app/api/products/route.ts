import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/products?cat=OLM&q=cast — typeahead behind the forms' brand/type
 * fields. tb_products holds ~3.9k rows scraped from the Turboly tenant
 * (scripts/import-turboly-export.mjs); the BAN category alone is 3.3k, which
 * is exactly why this is a capped server-side search and the client never
 * receives a whole category.
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const cat = (url.searchParams.get('cat') ?? '').toUpperCase();
  const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
  if (!cat) return NextResponse.json({ error: 'cat_required' }, { status: 400 });

  const filter: Record<string, unknown> = { category: cat };
  if (q) {
    // Space-separated terms must all appear — "brid 185" finds Bridgestone 185/…
    filter.$and = q.split(/\s+/).map((t) => ({ search: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }));
  }
  const rows = await getDb()
    .collection<{ _id: string; name: string; brand: string | null }>('tb_products')
    .find(filter, { projection: { name: 1, brand: 1 }, limit: 20, sort: { _id: 1 } })
    .toArray();

  return NextResponse.json({ products: rows.map((r) => ({ sku: r._id, name: r.name, brand: r.brand })) });
}
