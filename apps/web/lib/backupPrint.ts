import { SERVICES, CONDITION_ITEMS, BRANCHES } from './refdata.client';

/**
 * The printable rendition of one document inside the pre-purge backup zip.
 *
 * The live /print pages cannot serve this purpose: they are client-rendered
 * against /api/spk/[id], and the whole reason this backup exists is that those
 * documents are about to be DELETED — a link would point at nothing. So each
 * record gets a fully self-contained HTML file: inline CSS, signature images
 * embedded as the data URLs they already are, no fetches. Open → Cetak → the
 * paper is back.
 *
 * Deliberately an ARCHIVAL layout, not a replica of the pixel-faithful sheet:
 * duplicating those two React layouts server-side would drift from them the
 * first time either changes. This prints what was recorded, in reading order,
 * and says which document it came from.
 */

interface AnyDoc {
  _id?: unknown;
  docType?: string;
  branchCode?: string;
  createdAt?: string;
  customer?: { nama?: string; waE164?: string | null; alamat?: { fullText?: string } | string | null };
  vehicle?: {
    noPolisi?: { display?: string; full?: string };
    merkNormalized?: string | null; merk?: string | null;
    tipeNormalized?: string | null; tipe?: string | null;
    tahun?: number | null; warna?: string | null;
    km?: { value?: number | null };
  };
  complaint?: { keluhan?: string | null };
  jobLines?: Array<{ serviceCode?: string; qty?: number; keterangan?: string | null; quotedPrice?: number | null; turbolySku?: string | null }>;
  conditionChecks?: Array<{ item?: string; marks?: string[] }>;
  estimasi?: { minutes?: number | null };
  turboly?: { serviceOrderNo?: string | null };
  checkGo?: {
    harga?: number | null;
    mechanicName?: string | null;
    inspectionItems?: Array<{ item?: string; hasil?: string | null; catatan?: string | null; feedback?: string | null }>;
  } | null;
  signatures?: Record<string, { namaJelas?: string | null; imageDataUrl?: string | null }>;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const svcLabel = (code: string): string => SERVICES.find((s) => s.code === code)?.label ?? code;
const condLabel = (code: string): string => CONDITION_ITEMS.find((c) => c.code === code)?.label ?? code;
const rupiah = (n: number | null | undefined): string => (n == null ? '' : `Rp ${n.toLocaleString('id-ID')}`);
const tanggal = (iso: string | undefined): string =>
  iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) : '';

export function renderBackupPrintHtml(doc: AnyDoc): string {
  const isCG = doc.docType === 'CHECK_AND_GO';
  const plate = doc.vehicle?.noPolisi?.display ?? doc.vehicle?.noPolisi?.full ?? '';
  const branch = BRANCHES.find((b) => b.code === doc.branchCode)?.name ?? doc.branchCode ?? '';
  const alamat = typeof doc.customer?.alamat === 'string' ? doc.customer.alamat : doc.customer?.alamat?.fullText ?? '';

  const rows: string[] = [];

  if (isCG && doc.checkGo?.inspectionItems?.length) {
    rows.push(`<h2>Hasil Pemeriksaan (${doc.checkGo.inspectionItems.length} baris)</h2>
<table><thead><tr><th>Item</th><th>Hasil</th><th>Catatan</th></tr></thead><tbody>
${doc.checkGo.inspectionItems.map((it) => `<tr${/^Rekomendasi/.test(it.item ?? '') ? ' class="rek"' : ''}><td>${esc(it.item)}</td><td>${esc(it.feedback ?? it.hasil)}</td><td>${esc(it.catatan)}</td></tr>`).join('\n')}
</tbody></table>`);
  }

  if (doc.jobLines?.length) {
    rows.push(`<h2>Pekerjaan</h2>
<table><thead><tr><th>Jasa</th><th>Qty</th><th>Keterangan</th><th>SKU</th><th>Harga</th></tr></thead><tbody>
${doc.jobLines.map((l) => `<tr><td>${esc(svcLabel(l.serviceCode ?? ''))}</td><td>${esc(l.qty)}</td><td>${esc(l.keterangan)}</td><td>${esc(l.turbolySku)}</td><td>${esc(rupiah(l.quotedPrice))}</td></tr>`).join('\n')}
</tbody></table>`);
  }

  const marked = (doc.conditionChecks ?? []).filter((c) => c.marks?.length);
  if (!isCG && doc.conditionChecks?.length) {
    rows.push(`<h2>Pengecekan Awal</h2>
<p>${marked.length === 0 ? 'Semua item OK.' : ''}</p>
${marked.length ? `<table><tbody>${marked.map((c) => `<tr><td>${esc(condLabel(c.item ?? ''))}</td><td>${esc((c.marks ?? []).join(', '))}</td></tr>`).join('')}</tbody></table>` : ''}`);
  }

  if (!isCG && doc.complaint?.keluhan) rows.push(`<h2>Keluhan</h2><p>${esc(doc.complaint.keluhan)}</p>`);

  const sig = (who: string, label: string): string => {
    const s = doc.signatures?.[who];
    if (!s?.imageDataUrl && !s?.namaJelas) return '';
    return `<div class="sig">
  <div class="sig-label">${esc(label)}</div>
  ${s.imageDataUrl ? `<img src="${s.imageDataUrl}" alt="">` : '<div class="sig-empty">(tanpa tanda tangan gambar)</div>'}
  <div class="sig-name">( ${esc(s.namaJelas ?? ' ')} )</div>
</div>`;
  };

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(isCG ? 'Check & Go' : 'SPK')} ${esc(plate)} — ${esc(doc.customer?.nama)}</title>
<style>
  :root { --blue: #0a3d8f; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 Arial, sans-serif; color: #14213d; max-width: 210mm; margin: 0 auto; padding: 12mm; }
  header { border-bottom: 3px solid var(--blue); padding-bottom: 6px; margin-bottom: 10px; }
  header b { color: var(--blue); font-size: 20px; letter-spacing: 1px; }
  header small { float: right; color: #667; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin-bottom: 8px; }
  .meta div b { display: inline-block; min-width: 92px; font-weight: 600; }
  h2 { font-size: 13px; color: #fff; background: var(--blue); padding: 2px 8px; margin: 12px 0 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #b9c6de; padding: 2px 6px; text-align: left; }
  th { background: #e6eefb; }
  tr.rek td { background: #fef9e7; }
  .sigs { display: flex; gap: 24px; margin-top: 16px; }
  .sig { flex: 1; text-align: center; border: 1px solid #b9c6de; border-radius: 6px; padding: 8px; }
  .sig img { max-height: 60px; max-width: 100%; }
  .sig-label { font-size: 11px; color: #667; }
  .sig-name { border-top: 1px solid #9fb2d4; margin-top: 4px; padding-top: 3px; font-size: 12px; }
  .sig-empty { height: 60px; display: grid; place-items: center; color: #aab; font-size: 11px; }
  footer { margin-top: 14px; border-top: 1px solid #b9c6de; padding-top: 4px; font-size: 10px; color: #667; }
  @media print { body { padding: 0; } @page { size: A4; margin: 12mm; } }
</style>
<header><b>NAWILIS</b> — ${esc(isCG ? 'CHECK & GO REPORT' : 'SURAT PERINTAH KERJA')}<small>arsip backup</small></header>
<div class="meta">
  <div><b>No. Polisi</b> ${esc(plate)}</div><div><b>Cabang</b> ${esc(branch)}</div>
  <div><b>Customer</b> ${esc(doc.customer?.nama)}</div><div><b>WhatsApp</b> ${esc(doc.customer?.waE164)}</div>
  <div><b>Kendaraan</b> ${esc([doc.vehicle?.merkNormalized ?? doc.vehicle?.merk, doc.vehicle?.tipeNormalized ?? doc.vehicle?.tipe, doc.vehicle?.tahun, doc.vehicle?.warna].filter(Boolean).join(' · '))}</div>
  <div><b>KM</b> ${esc(doc.vehicle?.km?.value?.toLocaleString('id-ID'))}</div>
  <div><b>Tanggal</b> ${esc(tanggal(doc.createdAt))} WIB</div><div><b>Alamat</b> ${esc(alamat)}</div>
  ${doc.turboly?.serviceOrderNo ? `<div><b>Turboly SO</b> ${esc(doc.turboly.serviceOrderNo)}</div>` : ''}
  ${isCG && doc.checkGo?.mechanicName ? `<div><b>Diperiksa oleh</b> ${esc(doc.checkGo.mechanicName)}</div>` : ''}
  ${isCG && doc.checkGo?.harga != null ? `<div><b>General Check</b> ${esc(rupiah(doc.checkGo.harga))}</div>` : ''}
</div>
${rows.join('\n')}
<div class="sigs">${sig('menyerahkan', 'Yang menyerahkan (customer)')}${sig('menerima', 'Yang menerima (Service Advisor)')}</div>
<footer>Dokumen digital ${esc(doc._id)} · diarsipkan dari backup pra-hapus · dicetak ulang dari data tersimpan</footer>
`;
}
