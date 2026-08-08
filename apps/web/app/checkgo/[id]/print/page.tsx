'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { BRANCHES, CHECKGO_SECTIONS, CHECKGO_TIRE } from '../../../../lib/refdata.client';

/**
 * /checkgo/[id]/print — a captured Check & Go rendered back onto the final-3
 * paper it came from, the same way /spk/[id]/print does for the SPK.
 *
 * Read-only: codes from `checkGo.report` are resolved against the SAME refdata
 * tables the form rendered, so the printout always says what the sheet said,
 * in the current wording. Verdict pairs are drawn like the paper draws them —
 * both words printed, the chosen one inked. Browser print is the export.
 */

interface ReportItem { code: string; verdict: string | null; readings: Array<{ code: string; value: string }> }
interface ReportSection { code: string; verdict: string | null; items: ReportItem[]; rekomendasi: string[]; rekomendasiLain: string | null; extraParts: string[] }
interface Doc {
  _id: string;
  branchCode: string;
  capture?: { businessDate?: string; receivedAt?: string };
  customer?: { nama?: string; waE164?: string | null; kontakLain?: string | null };
  vehicle?: {
    noPolisi?: { display?: string; full?: string };
    merkNormalized?: string | null; merk?: string | null;
    tipeNormalized?: string | null; tipe?: string | null;
    km?: { value?: number | null };
  };
  checkGo?: {
    mechanicName?: string | null;
    report?: {
      sections: ReportSection[];
      tires: Array<{ position: string; merkUkuran: string | null; tekanan: string | null; flags: string[] }>;
      tireRekomendasi: { picks: string[]; lain: string[] };
    } | null;
  };
  signatures?: {
    menyerahkan?: { namaJelas?: string | null; imageDataUrl?: string | null };
    menerima?: { namaJelas?: string | null; imageDataUrl?: string | null };
  };
  turboly?: { serviceOrderNo?: string | null };
}

const fmtDate = (iso?: string): string =>
  iso ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

/** The paper prints both words; the chosen one gets the ink. */
function VerdictPair({ options, chosen }: { options?: ReadonlyArray<{ code: string; label: string }>; chosen: string | null }) {
  if (!options) return null;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {options.map((o) => (
        <span
          key={o.code}
          style={{
            display: 'inline-block', minWidth: 44, textAlign: 'center', margin: '0 2px',
            padding: '0 4px', border: '1px solid #b9c6de', fontSize: 10,
            ...(chosen === o.code ? { background: 'var(--nawilis)', color: '#fff', fontWeight: 700 } : { color: '#8a99b8' }),
          }}
        >
          {o.label}
        </span>
      ))}
    </span>
  );
}

function Tick({ on, label }: { on: boolean; label: string }) {
  return (
    <div style={{ fontSize: 10, ...(on ? { fontWeight: 700 } : { color: '#8a99b8' }) }}>
      {on ? '☑' : '□'} {label}
    </div>
  );
}

export default function PrintCheckGo() {
  const params = useParams<{ id: string }>();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    fetch(`/api/spk/${encodeURIComponent(params.id)}`)
      .then(async (r) => {
        if (!r.ok) { setErr(r.status === 404 ? 'Dokumen tidak ditemukan.' : `Gagal memuat (HTTP ${r.status}).`); return; }
        const d = (await r.json()) as Doc;
        setDoc(d);
      })
      .catch(() => setErr('Jaringan bermasalah — muat ulang halaman.'));
  }, [params?.id]);

  // ?print=1 — the intake forms land here straight after Simpan, and the whole
  // point of the redirect is the paper: open the dialog as soon as the document
  // has rendered. Small delay so the logo and layout settle first.
  useEffect(() => {
    if (!doc) return;
    if (!/[?&]print=1/.test(window.location.search)) return;
    const t = setTimeout(() => window.print(), 700);
    return () => clearTimeout(t);
  }, [doc]);

  if (err) return <div style={{ padding: 40, textAlign: 'center' }}>{err}</div>;
  if (!doc) return <div style={{ padding: 40, textAlign: 'center' }}>Memuat Check &amp; Go…</div>;

  const repRaw = doc.checkGo?.report ?? null;
  // Documents captured before the final-3 sheet carry the OLD report shape —
  // no tireRekomendasi, different section/item structure. Rendering them as if
  // they were new crashed the whole page (undefined.picks). They print as a
  // blank final-3 sheet with the header data, plus a banner saying why.
  const isFinal3 = !!repRaw && typeof repRaw === 'object' && 'tireRekomendasi' in repRaw;
  const rep = isFinal3 ? repRaw : null;
  const secOf = (code: string): ReportSection | undefined => (rep?.sections ?? []).find((s) => s.code === code);
  const branch = BRANCHES.find((b) => b.code === doc.branchCode);
  const email = /^email:/i.test(doc.customer?.kontakLain ?? '') ? (doc.customer?.kontakLain ?? '').replace(/^email:\s*/i, '') : '';
  const checker = doc.checkGo?.mechanicName ?? doc.signatures?.menerima?.namaJelas ?? '';

  return (
    <div className="sheet-wrap print-wrap">
      <div className="no-print" style={{ maxWidth: 820, margin: '0 auto 12px', display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn primary" onClick={() => window.print()}>🖨 Cetak / Simpan PDF</button>
      </div>

      <div className="sheet">
        <div className="hd">
          <div className="logo"><img src="/nawilis-logo.webp" alt="NAWILIS — Spooring - Balancing Specialist" style={{ height: 34, width: 'auto', display: 'block' }} /></div>
          <div className="title"><b>CHECK and GO REPORT</b><small>SAFETY &amp; COMFORT FIRST</small></div>
          <div className="serial">{doc._id.slice(-8)}</div>
        </div>

        {/* Header grid, exactly the paper's six boxes. */}
        <table className="pk">
          <tbody>
            <tr>
              <td style={{ width: '34%' }}><b>No. Mobil :</b> {doc.vehicle?.noPolisi?.display ?? doc.vehicle?.noPolisi?.full ?? ''}</td>
              <td style={{ width: '33%' }}><b>Model :</b> {[doc.vehicle?.merkNormalized ?? doc.vehicle?.merk, doc.vehicle?.tipeNormalized ?? doc.vehicle?.tipe].filter(Boolean).join(' ')}</td>
              <td><b>Odometer :</b> {doc.vehicle?.km?.value != null ? doc.vehicle.km.value.toLocaleString('id-ID') : ''}</td>
            </tr>
            <tr>
              <td><b>Nama :</b> {doc.customer?.nama ?? ''}</td>
              <td><b>No. Telp :</b> {doc.customer?.waE164 ?? ''}</td>
              <td><b>Email :</b> {email}</td>
            </tr>
          </tbody>
        </table>

        {repRaw && !isFinal3 && (
          <div className="no-print" style={{ marginTop: 6, padding: '6px 8px', background: '#fef3c7', border: '1px solid #d97706', borderRadius: 6, fontSize: 11 }}>
            ⚠ Laporan ini direkam dengan format lembar LAMA — kolom di bawah kosong; data aslinya tetap tersimpan di dokumen.
          </div>
        )}

        {/* Sections 1-7, each with its Rekomendasi column like the paper. */}
        {CHECKGO_SECTIONS.map((sec) => {
          const s = secOf(sec.code);
          const itemOf = (code: string): ReportItem | undefined => (s?.items ?? []).find((i) => i.code === code);
          const readingText = (itCode: string): string => {
            const def = sec.items.find((x) => x.code === itCode);
            const gi = itemOf(itCode);
            return (def?.readings ?? [])
              .map((rd) => {
                const v = (gi?.readings ?? []).find((x) => x.code === rd.code)?.value ?? '';
                return `${rd.label}: ${v || '…'}${v && rd.suffix ? ` ${rd.suffix}` : ''}`;
              })
              .join('   ');
          };
          return (
            <table key={sec.code} className="pk" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }} colSpan={2}>{sec.no}. {sec.title}</th>
                  <th style={{ width: '30%' }}>Rekomendasi</th>
                </tr>
              </thead>
              <tbody>
                {sec.items.map((it, idx) => (
                  <tr key={it.code}>
                    <td>
                      ({String.fromCharCode(97 + idx)}) {it.label}
                      {it.readings?.length ? <span style={{ color: '#445', marginLeft: 6 }}>{readingText(it.code)}</span> : null}
                    </td>
                    <td style={{ width: 120, textAlign: 'center' }}>
                      {it.verdicts ? (
                        <VerdictPair options={it.verdicts} chosen={itemOf(it.code)?.verdict ?? null} />
                      ) : sec.verdicts && idx === 0 ? (
                        <VerdictPair options={sec.verdicts} chosen={s?.verdict ?? null} />
                      ) : null}
                    </td>
                    {idx === 0 && (
                      <td rowSpan={sec.items.length} style={{ verticalAlign: 'top' }}>
                        {sec.rekomendasi.map((o) => (
                          <Tick
                            key={o.code}
                            on={!!(s?.rekomendasi ?? []).includes(o.code)}
                            label={o.freeText && s?.rekomendasiLain ? `${o.label} ${s.rekomendasiLain}` : o.label}
                          />
                        ))}
                        {sec.extraList && (
                          <div style={{ marginTop: 4 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, textDecoration: 'underline' }}>{sec.extraList.label}:</div>
                            {Array.from({ length: sec.extraList.count }, (_, i) => (
                              <div key={i} style={{ fontSize: 10, borderBottom: '1px solid #b9c6de', minHeight: 13 }}>
                                {i + 1}. {s?.extraParts[i] ?? ''}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })}

        {/* Section 8 — the four wheels, 2×2, with the tire recommendations. */}
        <table className="pk" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }} colSpan={2}>{CHECKGO_TIRE.no}. {CHECKGO_TIRE.title}</th>
              <th style={{ width: '30%' }}>Rekomendasi</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1].map((row) => (
              <tr key={row}>
                {[0, 1].map((col) => {
                  const pos = CHECKGO_TIRE.positions[row * 2 + col]!;
                  const t = (rep?.tires ?? []).find((x) => x.position === pos.code);
                  return (
                    <td key={pos.code} style={{ width: '35%', verticalAlign: 'top' }}>
                      <div style={{ fontWeight: 700, fontSize: 10 }}>({String.fromCharCode(97 + row * 2 + col)}) <i>{pos.label}</i></div>
                      <div style={{ fontSize: 10 }}>Merk dan ukuran: {t?.merkUkuran ?? ''}</div>
                      <div style={{ fontSize: 10 }}>
                        Tekanan Ban : <VerdictPair options={CHECKGO_TIRE.tekanan} chosen={t?.tekanan ?? null} />
                      </div>
                      <div style={{ display: 'flex', gap: 10 }}>
                        {CHECKGO_TIRE.flags.map((f) => (
                          <Tick key={f.code} on={!!(t?.flags ?? []).includes(f.code)} label={f.label} />
                        ))}
                      </div>
                    </td>
                  );
                })}
                {row === 0 && (
                  <td rowSpan={2} style={{ verticalAlign: 'top' }}>
                    {CHECKGO_TIRE.rekomendasi.map((o) => (
                      <Tick key={o.code} on={!!(rep?.tireRekomendasi?.picks ?? []).includes(o.code)} label={o.label} />
                    ))}
                    {Array.from({ length: CHECKGO_TIRE.freeLines }, (_, i) => (
                      <div key={i} style={{ fontSize: 10, borderBottom: '1px solid #b9c6de', minHeight: 13 }}>
                        □ {rep?.tireRekomendasi?.lain?.[i] ?? ''}
                      </div>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Footer, the paper's three boxes. */}
        <table className="pk" style={{ marginTop: 6 }}>
          <tbody>
            <tr>
              <td style={{ width: '34%' }}><b>Tanggal :</b> {fmtDate(doc.capture?.receivedAt ?? doc.capture?.businessDate)}</td>
              <td style={{ width: '33%' }}><b>Diperiksa Oleh :</b> {checker}</td>
              <td><b>Cabang :</b> {branch?.name ?? doc.branchCode}</td>
            </tr>
          </tbody>
        </table>

        {/* Signatures: drawn on the tablet at intake; the printout carries them. */}
        <table className="pk" style={{ marginTop: 6 }}>
          <tbody>
            <tr>
              {([['Yang menyerahkan,', doc.signatures?.menyerahkan], ['Yang menerima,', doc.signatures?.menerima]] as const).map(([label, sg]) => (
                <td key={label} style={{ width: '50%', textAlign: 'center', verticalAlign: 'bottom', height: 86 }}>
                  <div style={{ fontSize: 10 }}>{label}</div>
                  {sg?.imageDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sg.imageDataUrl} alt="" style={{ height: 44, margin: '2px auto', display: 'block' }} />
                  ) : (
                    <div style={{ height: 44 }} />
                  )}
                  <div style={{ fontSize: 10, borderTop: '1px solid #9fb2d4', width: 170, margin: '0 auto', paddingTop: 2 }}>
                    ( {sg?.namaJelas ?? '\u00a0'} )
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        {/* Digital provenance — the one block the paper never had. */}
        <div style={{ fontSize: 9, color: '#667', marginTop: 8, borderTop: '1px solid #b9c6de', paddingTop: 4 }}>
          Dokumen digital {doc._id} · {branch?.name ?? doc.branchCode}
          {doc.turboly?.serviceOrderNo ? ` · SO ${doc.turboly.serviceOrderNo}` : ''}
        </div>
        <div className="foot">Pioneering wheel alignment and balancing for more than 50 years</div>
      </div>

      <style jsx global>{`
        @page { size: A4; margin: 10mm; }
        @page { size: A4; margin: 10mm; }
        @media print {
          .no-print { display: none !important; }
          .print-wrap table.pk { break-inside: avoid; }
          .print-wrap table.pk { break-inside: avoid; }
          .print-wrap { background: #fff !important; padding: 0 !important; }
          .print-wrap .sheet { box-shadow: none !important; border-width: 1.5px; width: 100%; }
          nav, header { display: none !important; }
        }
      `}</style>
    </div>
  );
}
