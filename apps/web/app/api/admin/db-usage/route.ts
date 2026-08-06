import { NextResponse } from 'next/server';
import { getDb } from '@spk/core';
import { db } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/admin/db-usage — per-collection storage, for the admin console. */
export async function GET(): Promise<Response> {
  await db();
  const d = getDb();
  const names = (await d.listCollections().toArray()).map((c) => c.name);
  const collections = [];
  for (const name of names) {
    const s = (await d.command({ collStats: name }).catch(() => null)) as
      | { count: number; size: number; storageSize: number; totalIndexSize: number }
      | null;
    if (s) collections.push({ name, count: s.count, dataBytes: s.size, storageBytes: s.storageSize, indexBytes: s.totalIndexSize });
  }
  collections.sort((a, b) => b.dataBytes - a.dataBytes);
  const totals = collections.reduce(
    (t, c) => ({ dataBytes: t.dataBytes + c.dataBytes, storageBytes: t.storageBytes + c.storageBytes, indexBytes: t.indexBytes + c.indexBytes }),
    { dataBytes: 0, storageBytes: 0, indexBytes: 0 },
  );
  return NextResponse.json({ dbName: d.databaseName, collections, totals });
}
