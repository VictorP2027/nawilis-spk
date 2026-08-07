'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { SERVICES, BRANCHES, CONDITION_ITEMS } from '../../../../lib/refdata.client';

/**
 * /spk/[id]/print — a captured SPK rendered back onto the paper it came from.
 *
 * Read-only twin of the /sheet intake form: same layout, same global `.sheet`
 * styles, but every field shows what the DOCUMENT says instead of an input.
 * Exists so a branch can hand the customer (or an auditor) the familiar
 * printed SURAT PERINTAH KERJA for any digital intake — browser print is the
 * export. Nothing here writes; the one fetch is the existing GET /api/spk/:id.
 */

interface Doc {
  _id: string;
  branchCode: string;
  state: string;
  capture?: { businessDate?: string; receivedAt?: string };
  customer?: { nama?: string; waE164?: string | null; alamat?: string | null; kontakLain?: string | null };
  vehicle?: {
    noPolisi?: { display?: string; full?: string };
    merk?: string | null; merkNormalized?: string | null;
    tipe?: string | null; tipeNormalized?: string | null;
    tahun?: number | null; warna?: string | null;
    km?: { value?: number | null };
  };
  complaint?: { keluhan?: string | null };
  jobLines?: Array<{
    serviceCode: string; ordered: boolean; qty: number; keterangan: string | null;
    mk?: { mechanicCode?: string | null }; waktu?: { minutes?: number | null };
  }>;
  conditionChecks?: Array<{ item: string; marks: string[]; status?: string }>;
  signatures?: {
    menyerahkan?: { present?: boolean; namaJelas?: string | null; imageDataUrl?: string | null };
    menerima?: { present?: boolean; namaJelas?: string | null; imageDataUrl?: string | null };
  };
  estimasi?: { minutes?: number | null };
  turboly?: { serviceOrderNo?: string | null; workOrderNo?: string | null };
  rekomendasiService?: string | null;
}

const fmtDate = (iso?: string): string =>
  iso ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

export default function PrintSpk() {
  const params = useParams<{ id: string }>();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    fetch(`/api/spk/${encodeURIComponent(params.id)}`)
      .then(async (r) => {
        if (!r.ok) { setErr(r.status === 404 ? 'Dokumen tidak ditemukan.' : `Gagal memuat (HTTP ${r.status}).`); return; }
        setDoc((await r.json()) as Doc);
      })
      .catch(() => setErr('Jaringan bermasalah — muat ulang halaman.'));
  }, [params?.id]);

  if (err) return <div style={{ padding: 40, textAlign: 'center' }}>{err}</div>;
  if (!doc) return <div style={{ padding: 40, textAlign: 'center' }}>Memuat SPK…</div>;

  const lines = new Map((doc.jobLines ?? []).map((l) => [l.serviceCode, l]));
  const extraLines = (doc.jobLines ?? []).filter((l) => !SERVICES.some((s) => s.code === l.serviceCode));
  const conds = new Map((doc.conditionChecks ?? []).map((c) => [c.item, c]));
  const branch = BRANCHES.find((b) => b.code === doc.branchCode);
  const sig = doc.signatures ?? {};

  return (
    <div className="sheet-wrap print-wrap">
      {/* Browser print IS the export — hidden on paper. */}
      <div className="no-print" style={{ maxWidth: 820, margin: '0 auto 12px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn primary" onClick={() => window.print()}>🖨 Cetak / Simpan PDF</button>
      </div>

      <div className="sheet">
        <div className="hd">
          <div className="logo"><div className="word">NAWILIS<small>SPOORING · BALANCING SPECIALIST</small></div></div>
          <div className="title">
            <b>SURAT PERINTAH KERJA (S.P.K.)</b>
            <small>{branch?.name ?? doc.branchCode}</small>
          </div>
          <div className="serial">{doc._id.slice(-8)}</div>
        </div>

        <div className="two">
          <div className="box">
            <span className="sec-h">INFORMASI CUSTOMER</span>
            <div className="fld"><label>Tanggal</label><span>{fmtDate(doc.capture?.receivedAt ?? doc.capture?.businessDate)}</span></div>
            <div className="fld"><label>Nama</label><span>{doc.customer?.nama ?? ''}</span></div>
            <div className="fld"><label>Alamat</label><span>{doc.customer?.alamat ?? ''}</span></div>
            <div className="fld"><label>Nomor WA</label><span>{doc.customer?.waE164 ?? ''}</span></div>
          </div>
          <div className="box">
            <span className="sec-h">INFORMASI KENDARAAN</span>
            <div className="fld"><label>Merk Mobil</label><span>{doc.vehicle?.merkNormalized ?? doc.vehicle?.merk ?? ''}</span></div>
            <div className="fld"><label>Tipe</label><span>{doc.vehicle?.tipeNormalized ?? doc.vehicle?.tipe ?? ''}</span></div>
            <div className="fld"><label>No. Polisi</label><span>{doc.vehicle?.noPolisi?.display ?? doc.vehicle?.noPolisi?.full ?? ''}</span></div>
            <div className="fld"><label>Tahun/Warna</label><span>{[doc.vehicle?.tahun, doc.vehicle?.warna].filter(Boolean).join(' / ')}</span></div>
            <div className="fld"><label>KM</label><span>{doc.vehicle?.km?.value != null ? doc.vehicle.km.value.toLocaleString('id-ID') : ''}</span></div>
          </div>
        </div>

        <div className="box" style={{ marginTop: 8, minHeight: 40 }}>
          <span className="sec-h">KELUHAN</span>
          <div style={{ fontSize: 12 }}>{doc.complaint?.keluhan ?? ''}</div>
        </div>

        <table className="pk" style={{ marginTop: 8 }}>
          <thead>
            <tr><th style={{ width: 18 }}>#</th><th>PEKERJAAN</th><th style={{ width: 70 }}>ORDER</th><th>KETERANGAN</th><th style={{ width: 60 }}>MK</th><th style={{ width: 50 }}>WAKTU</th></tr>
          </thead>
          <tbody>
            {SERVICES.map((s, i) => {
              const l = lines.get(s.code);
              const on = !!l?.ordered;
              return (
                <tr key={s.code} style={on ? { background: '#EAF0FF' } : undefined}>
                  <td style={{ textAlign: 'center' }}>{i + 1}</td>
                  <td>{s.label.toUpperCase()}{s.tag ? ` (${s.tag})` : ''}</td>
                  <td style={{ textAlign: 'center', fontWeight: 700 }}>
                    {on ? (s.unit === 'check' ? '✓' : `${l!.qty} ${s.unit === 'pcs' ? 'pcs' : 'ltr'}`) : ''}
                  </td>
                  <td>{l?.keterangan ?? ''}</td>
                  <td>{l?.mk?.mechanicCode && l.mk.mechanicCode !== 'UNASSIGNED' ? l.mk.mechanicCode : ''}</td>
                  <td>{l?.waktu?.minutes != null ? `${l.waktu.minutes}m` : ''}</td>
                </tr>
              );
            })}
            {extraLines.map((l, i) => (
              <tr key={l.serviceCode} style={{ background: '#EAF0FF' }}>
                <td style={{ textAlign: 'center' }}>{SERVICES.length + i + 1}</td>
                <td>{l.serviceCode}</td>
                <td style={{ textAlign: 'center', fontWeight: 700 }}>{l.qty > 1 ? l.qty : '✓'}</td>
                <td>{l.keterangan ?? ''}</td>
                <td /><td />
              </tr>
            ))}
          </tbody>
        </table>

        <div className="box" style={{ marginTop: 8 }}>
          <span className="sec-h">PENGECEKAN AWAL KENDARAAN</span>
          <table className="pk">
            <tbody>
              {CONDITION_ITEMS.map((c, i) => {
                const got = conds.get(c.code);
                const marks = got?.marks ?? [];
                return (
                  <tr key={c.code}>
                    <td style={{ width: 18, textAlign: 'center' }}>{i + 1}</td>
                    <td>{c.label}</td>
                    <td style={{ width: 220 }}>{marks.length ? marks.join(', ') : 'OK'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: 10, marginTop: 8 }}>
          Saya yang bertanda tangan dibawah ini memberi wewenang penuh kepada bengkel NAWILIS untuk melakukan
          pekerjaan sesuai dengan permintaan order di atas dan test jalan apabila diperlukan.
        </div>

        <div className="two" style={{ marginTop: 6 }}>
          {([['Yang menyerahkan,', sig.menyerahkan], ['Yang menerima,', sig.menerima]] as const).map(([label, s]) => (
            <div key={label} className="box" style={{ minHeight: 90, textAlign: 'center' }}>
              <div style={{ fontSize: 11 }}>{label}</div>
              {s?.imageDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.imageDataUrl} alt="" style={{ height: 48, margin: '4px auto', display: 'block' }} />
              ) : (
                <div style={{ height: 48 }} />
              )}
              <div style={{ fontSize: 11, borderTop: '1px solid #9fb2d4', width: 160, margin: '0 auto', paddingTop: 2 }}>
                ( {s?.namaJelas ?? ' '} )
              </div>
            </div>
          ))}
        </div>

        <div className="two" style={{ marginTop: 8 }}>
          <div className="fld"><label>Kontak Lain</label><span>{doc.customer?.kontakLain ?? ''}</span></div>
          <div className="fld"><label>Estimasi waktu</label><span>{doc.estimasi?.minutes != null ? `${doc.estimasi.minutes} menit` : ''}</span></div>
        </div>

        {/* Digital provenance — the one block the paper never had. */}
        <div style={{ fontSize: 9, color: '#667', marginTop: 8, borderTop: '1px solid #b9c6de', paddingTop: 4 }}>
          Dokumen digital {doc._id} · {branch?.name ?? doc.branchCode}
          {doc.turboly?.serviceOrderNo ? ` · SO ${doc.turboly.serviceOrderNo}` : ''}
          {doc.turboly?.workOrderNo ? ` · WO ${doc.turboly.workOrderNo}` : ''}
        </div>

        <div className="foot">Pioneering wheel alignment and balancing for more than 50 years</div>
      </div>

      <style jsx global>{`
        @media print {
          .no-print { display: none !important; }
          .print-wrap { background: #fff !important; padding: 0 !important; }
          .print-wrap .sheet { box-shadow: none !important; border-width: 1.5px; width: 100%; }
          nav, header { display: none !important; }
        }
      `}</style>
    </div>
  );
}
