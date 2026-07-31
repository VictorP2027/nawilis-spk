import ExcelJS from 'exceljs';
import { collections, NAWILIS_COLUMNS, toNawilisRow, isUsedInServiceOrder, type SpkDoc } from '@spk/core';
import { db } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/export?scope=used|all&outlet=NWL-PRG&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Produces an .xlsx in the EXACT Nawilis SPK schema.
 *   scope=all  → every captured SPK (the raw dump, like the source file)
 *   scope=used → ONLY the ones used in a Service Order (given to a mechanic)  ← default
 */
export async function GET(req: Request): Promise<Response> {
  await db();
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'used';
  const outlet = url.searchParams.get('outlet');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const q: Record<string, unknown> = {};
  if (outlet) q.branchCode = outlet;
  if (from || to) {
    const bd: Record<string, string> = {};
    if (from) bd.$gte = from;
    if (to) bd.$lte = to;
    q['capture.businessDate'] = bd;
  }
  if (scope === 'used') {
    q.$or = [{ assignment: { $ne: null } }, { state: { $in: ['queued', 'pushing', 'pushed', 'confirmed'] } }];
  }

  const docs = (await collections.spk().find(q, { sort: { 'capture.receivedAt': 1 } }).toArray()) as SpkDoc[];
  // Defensive second filter for `used` (keeps the definition in one place).
  const rows = (scope === 'used' ? docs.filter(isUsedInServiceOrder) : docs).map(toNawilisRow);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SPK');
  ws.columns = NAWILIS_COLUMNS.map((c) => ({ header: c, key: c, width: Math.min(28, Math.max(10, c.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  // Render the timestamp column as an Excel date-time (matches the source serials).
  const tsCol = ws.getColumn('timestamp');
  tsCol.numFmt = 'yyyy-mm-dd hh:mm';

  const buf = await wb.xlsx.writeBuffer();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = `SPK_export_${scope}_${outlet ?? 'all'}_${today}.xlsx`;
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}
