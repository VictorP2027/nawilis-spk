import ExcelJS from 'exceljs';
import { NAWILIS_COLUMNS, toNawilisRow, isUsedInServiceOrder, exportRows } from '@spk/core-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/export?scope=used|all&outlet=&from=&to= — .xlsx in the exact Nawilis
 * schema. scope=used (default) = only SPKs given to a mechanic.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'used';

  const docs = await exportRows({
    outlet: url.searchParams.get('outlet'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    used: scope === 'used',
  });
  const rows = (scope === 'used' ? docs.filter(isUsedInServiceOrder) : docs).map(toNawilisRow);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SPK');
  ws.columns = NAWILIS_COLUMNS.map((c) => ({ header: c, key: c, width: Math.min(28, Math.max(10, c.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.getColumn('timestamp').numFmt = 'yyyy-mm-dd hh:mm';

  const buf = await wb.xlsx.writeBuffer();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = `SPK_export_${scope}_${url.searchParams.get('outlet') ?? 'all'}_${today}.xlsx`;
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}
