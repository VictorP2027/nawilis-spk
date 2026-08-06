'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * /alerts — the WhatsApp send ledger, list-everything view.
 *
 * The flow board forgets a card after its window; this page never forgets:
 * every Check & Go ever captured, with what happened to its WhatsApp result —
 * delivered by the gateway, sent by a human on WhatsApp Web, still queued,
 * failed, or never sent. Search by plate/name/number, filter by status chip.
 */

interface LedgerRow {
  id: string;
  createdAt: string;
  branch: string;
  plate: string;
  customer: string;
  wa: string | null;
  mode: string | null;
  at: string | null;
  by: string | null;
  provider: string | null;
  error: string | null;
}

interface LedgerData {
  rows: LedgerRow[];
  counts: Record<string, number>;
  truncated: boolean;
}

const CHIPS: Array<{ key: string; label: string }> = [
  { key: '', label: 'Semua' },
  { key: 'live', label: '✓ Terkirim' },
  { key: 'manual', label: '📱 Manual' },
  { key: 'requested', label: '⏳ Antre' },
  { key: 'failed', label: '✗ Gagal' },
  { key: 'none', label: '— Belum' },
];

const MODE_BADGE: Record<string, { text: string; bg: string; fg: string }> = {
  live: { text: '✓ Terkirim', bg: '#e7f6ec', fg: '#116b2e' },
  manual: { text: '📱 Manual', bg: '#e8f0fe', fg: '#1a4fba' },
  requested: { text: '⏳ Antre', bg: '#fff4d6', fg: '#8a6100' },
  failed: { text: '✗ Gagal', bg: '#fdeaea', fg: '#a11a1a' },
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Year included: this ledger spans years, and "30 Jul" alone cannot settle
  // which year's visit a dispute is about.
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function AlertsLedgerPage() {
  const [data, setData] = useState<LedgerData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  // Debounce the search so typing doesn't fire a request per keystroke.
  const [qLive, setQLive] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(qLive), 350);
    return () => clearTimeout(t);
  }, [qLive]);

  const [authGone, setAuthGone] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (q !== '') params.set('q', q);
    if (status !== '') params.set('status', status);
    fetch(`/api/alerts/list?${params}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as LedgerData | null;
        // Guard AFTER the body parse too — a superseded request's headers can
        // arrive while it is still current, and its late body must not
        // clobber the newer filter's results.
        if (!live) return;
        if (r.status === 401 || r.status === 403) { setAuthGone(true); setLoading(false); return; }
        if (!r.ok || body === null) { setErr(`Gagal memuat (HTTP ${r.status})`); setLoading(false); return; }
        setData(body);
        setErr(null);
        setLoading(false);
      })
      .catch(() => { if (live) { setErr('Jaringan bermasalah — muat ulang.'); setLoading(false); } });
    return () => { live = false; };
  }, [q, status]);

  const total = useMemo(
    () => (data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0),
    [data],
  );

  return (
    <main className="al-page">
      <style>{`
        .al-page { max-width: 980px; margin: 0 auto; padding: 18px 14px 60px; }
        .al-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .al-title { font-size: 20px; font-weight: 900; color: var(--nawilis, #0a3d8f); }
        .al-total { font-size: 12.5px; color: #5a6b87; }
        .al-tools { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .al-search { flex: 1 1 220px; padding: 9px 12px; border: 1px solid #ccd5e3; border-radius: 8px; font-size: 14px; }
        .al-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
        .al-chip { border: 1px solid #ccd5e3; background: #fff; border-radius: 999px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; }
        .al-chip.on { background: var(--nawilis, #0a3d8f); border-color: var(--nawilis, #0a3d8f); color: #fff; }
        .al-tablewrap { margin-top: 14px; overflow-x: auto; border: 1px solid #e3e9f2; border-radius: 10px; background: #fff; }
        table.al { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px; }
        table.al th { text-align: left; padding: 9px 10px; background: #f4f6fb; color: #40506b; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
        table.al td { padding: 8px 10px; border-top: 1px solid #eef2f8; vertical-align: top; }
        .al-badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; white-space: nowrap; }
        .al-sub { color: #7d8aa0; font-size: 11.5px; margin-top: 2px; }
        .al-plate { font-weight: 800; white-space: nowrap; }
        .al-plate a { color: inherit; text-decoration: none; }
        .al-plate a:hover { text-decoration: underline; }
        .al-empty { padding: 26px; text-align: center; color: #7d8aa0; font-size: 13.5px; }
        .al-note { margin-top: 8px; font-size: 12px; color: #8a6100; }
        .al-back { font-size: 13px; text-decoration: none; color: var(--nawilis, #0a3d8f); }
        .al-err { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: #fdeaea; color: #a11a1a; font-size: 13px; }
      `}</style>

      <div className="al-head">
        <span className="al-title">📋 Riwayat WhatsApp</span>
        {data && <span className="al-total">{total} Check &amp; Go tercatat</span>}
        <span style={{ flex: 1 }} />
        <a className="al-back" href="/flow">← Papan alur</a>
      </div>

      <div className="al-tools">
        <input
          className="al-search"
          placeholder="Cari nomor polisi, nama, atau nomor WA…"
          value={qLive}
          onChange={(e) => setQLive(e.target.value)}
        />
      </div>

      <div className="al-chips">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`al-chip${status === c.key ? ' on' : ''}`}
            onClick={() => setStatus(c.key)}
          >
            {c.label}{data && c.key !== '' ? ` ${data.counts[c.key] ?? 0}` : ''}
          </button>
        ))}
      </div>

      {authGone && (
        <div className="al-err">
          Sesi berakhir — <a href="/login?next=%2Falerts">login ulang</a>.
        </div>
      )}
      {err && <div className="al-err">✗ {err}</div>}

      <div className="al-tablewrap">
        <table className="al">
          <thead>
            <tr>
              <th>Tanggal</th>
              <th>Kendaraan / Customer</th>
              <th>Cabang</th>
              <th>Status WA</th>
              <th>Dikirim</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr><td colSpan={5} className="al-empty">Memuat…</td></tr>
            )}
            {data && data.rows.length === 0 && !loading && (
              <tr><td colSpan={5} className="al-empty">Tidak ada dokumen yang cocok.</td></tr>
            )}
            {data?.rows.map((r) => {
              const badge = r.mode ? MODE_BADGE[r.mode] : null;
              return (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</td>
                  <td>
                    <div className="al-plate">
                      <a href={`/checkgo/${encodeURIComponent(r.id)}/print`} target="_blank" rel="noreferrer">{r.plate}</a>
                    </div>
                    <div className="al-sub">{r.customer}{r.wa ? ` · ${r.wa}` : ''}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.branch}</td>
                  <td>
                    {r.mode === 'manual' && !r.by ? (
                      // Legacy auto-stamps: the capture path minted a wa.me
                      // link with nobody recorded as sender — that is NOT a
                      // confirmed human send, and a dispute ledger must not
                      // dress it up as one.
                      <>
                        <span className="al-badge" style={{ background: '#fff4d6', color: '#8a6100' }}>🔗 Link dibuat</span>
                        <div className="al-sub">belum tentu terkirim</div>
                      </>
                    ) : badge ? (
                      <span className="al-badge" style={{ background: badge.bg, color: badge.fg }}>{badge.text}</span>
                    ) : r.mode ? (
                      <span className="al-badge" style={{ background: '#eef1f6', color: '#5a6b87' }}>{r.mode}</span>
                    ) : (
                      <span className="al-badge" style={{ background: '#eef1f6', color: '#5a6b87' }}>— Belum</span>
                    )}
                    {r.error && <div className="al-sub">{r.error}</div>}
                  </td>
                  <td>
                    <div style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.at)}</div>
                    {(r.by || r.provider) && <div className="al-sub">{[r.provider, r.by].filter(Boolean).join(' · ')}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data?.truncated && (
        <div className="al-note">
          Menampilkan {data.rows.length} dokumen terbaru — persempit dengan pencarian untuk melihat yang lebih lama.
        </div>
      )}
    </main>
  );
}
