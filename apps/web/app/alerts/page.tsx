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

interface WaPreview {
  profile: { nama: string; wa: string | null; plate: string; branch: string };
  to: string;
  /** Effective message: a pending staff edit when one is stored, else canonical. */
  text: string;
  /** The regenerated canonical wording — what "Kembalikan asli" restores. */
  canonicalText: string;
  /** The doc's CURRENT stamp, fresh from the server — the list row may be stale. */
  status: { mode?: string | null; by?: string | null } | null;
}

/**
 * Eligible for the manual bulk stepper: never sent, or carrying only a legacy
 * auto-stamp (mode 'manual' with no sender recorded — a wa.me link was minted
 * but nobody confirmed pressing send). Queued rows belong to the gateway and
 * live rows are done; both stay untickable.
 */
function stepperEligible(r: LedgerRow): boolean {
  return r.mode === null || (r.mode === 'manual' && !r.by);
}

/**
 * Zero-setup bulk send, ledger edition: the sender's own WhatsApp login is
 * the only infrastructure. One step per customer — the button opens the chat
 * with the full message pre-filled, the person presses send there, the doc is
 * stamped 'manual' (so no gateway or robot ever duplicates it), next loads.
 */
function ManualStepper({ targets, onClose, onSent }: {
  targets: LedgerRow[];
  onClose: () => void;
  onSent: (id: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [preview, setPreview] = useState<WaPreview | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [failedMarks, setFailedMarks] = useState<string[]>([]);
  const [marking, setMarking] = useState(false);
  const row = idx < targets.length ? targets[idx] : null;

  // The list row can be minutes stale; the fresh GET tells the truth. If
  // someone else already handled this customer, sending again would be a
  // duplicate — block the button, offer Lewati.
  const curMode = preview?.status?.mode ?? null;
  const alreadyHandled =
    curMode === 'live' || curMode === 'requested' || (curMode === 'manual' && Boolean(preview?.status?.by));

  useEffect(() => {
    if (!row) return;
    let live = true;
    setPreview(null);
    setErr(null);
    fetch(`/api/checkgo/${encodeURIComponent(row.id)}/alert`, { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
        if (!live) return;
        if (!r.ok || body === null) {
          setErr(typeof body?.message === 'string' ? body.message : 'Tidak bisa memuat pesan.');
          return;
        }
        setPreview(body as unknown as WaPreview);
        setDraft((body as unknown as WaPreview).text);
      })
      .catch(() => { if (live) setErr('Jaringan bermasalah — coba lagi.'); });
    return () => { live = false; };
  }, [row]);

  async function openAndMark() {
    if (!row || !preview || marking || alreadyHandled || draft.trim() === '') return;
    const canonical = preview.canonicalText ?? preview.text;
    const text = draft;
    // One tab per user click keeps popup blockers quiet — but a strict
    // blocker still returns null, and then NOTHING was sent: stamping would
    // silently bury this customer forever, so refuse instead.
    const tab = window.open(`https://wa.me/${preview.to}?text=${encodeURIComponent(text)}`, '_blank');
    if (tab === null) {
      setErr('Popup diblokir browser — izinkan popup untuk situs ini, lalu tekan tombol lagi.');
      return;
    }
    // The stamp is AWAITED before advancing: the record must match reality
    // before the next customer loads, and a failure must be told, not lost.
    setMarking(true);
    try {
      const res = await fetch(`/api/checkgo/${encodeURIComponent(row.id)}/alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The edited text rides on the stamp so the ledger records what was
        // actually sent, not what would have been generated.
        body: JSON.stringify({ by: 'alerts-ledger-manual', manual: true, ...(text !== canonical ? { text } : {}) }),
      });
      if (res.ok) {
        onSent(row.id);
        setSentCount((n) => n + 1);
      } else {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setFailedMarks((s) => [...s, `${row.plate}: ${res.status === 409 ? 'sudah ditangani pengirim lain' : body.message ?? `HTTP ${res.status}`}`]);
      }
    } catch {
      setFailedMarks((s) => [...s, `${row.plate}: jaringan — stempel GAGAL walau chat sudah terbuka`]);
    }
    setMarking(false);
    setPreview(null); // cleared here, not in the effect — no stale-customer frame
    setErr(null);
    setIdx((i) => i + 1);
  }

  function skip() {
    if (marking) return;
    if (row) setSkipped((s) => [...s, row.plate]);
    setPreview(null);
    setErr(null);
    setIdx((i) => i + 1);
  }

  function safeClose() {
    if (!marking) onClose();
  }

  return (
    <div className="al-ovr" onClick={safeClose}>
      <div className="al-modal" onClick={(e) => e.stopPropagation()}>
        {row ? (
          <>
            <div className="al-mtitle">Kirim manual — customer {idx + 1} dari {targets.length}</div>
            {err && (
              <div className="al-err" style={{ marginTop: 10 }}>
                ✗ {err} — <b>Lewati</b> untuk lanjut ke customer berikutnya.
              </div>
            )}
            {!preview && !err && <div className="al-sub" style={{ marginTop: 10 }}>Memuat pesan…</div>}
            {preview && (
              <>
                <div className="al-sub" style={{ marginTop: 8 }}>
                  <b>{preview.profile.nama}</b> · {preview.profile.wa ?? preview.to} · {preview.profile.plate} · {preview.profile.branch}
                </div>
                <textarea
                  className="al-msg al-msgedit"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={9}
                  maxLength={4000}
                  disabled={marking || alreadyHandled}
                />
                <div className="al-sub" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
                  <span>✏️ Pesan bisa diedit sebelum dikirim.</span>
                  {draft !== (preview.canonicalText ?? preview.text) && (
                    <button type="button" className="al-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setDraft(preview.canonicalText ?? preview.text)}>
                      ↺ Kembalikan asli
                    </button>
                  )}
                </div>
                {alreadyHandled ? (
                  <div className="al-err" style={{ marginTop: 6 }}>
                    ⚠ Sudah ditangani ({curMode === 'live' ? 'terkirim gateway' : curMode === 'requested' ? 'antre gateway' : 'dikirim manual'}) —
                    mengirim lagi berarti customer menerima dua kali. <b>Lewati</b>.
                  </div>
                ) : (
                  <div className="al-sub" style={{ marginTop: 6 }}>
                    Tombol di bawah membuka WhatsApp dengan pesan sudah terisi —
                    tekan kirim di sana, lalu kembali ke tab ini.
                  </div>
                )}
              </>
            )}
            <div className="al-mbtns">
              <button type="button" className="al-btn" disabled={marking} onClick={safeClose}>Berhenti</button>
              <button type="button" className="al-btn" disabled={marking} onClick={skip}>Lewati</button>
              <button type="button" className="al-btn primary" disabled={!preview || marking || alreadyHandled || draft.trim() === ''} onClick={() => void openAndMark()}>
                {marking ? 'Menandai…' : '📱 Buka WhatsApp & tandai terkirim'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="al-mtitle">Selesai</div>
            <div className="al-sub" style={{ marginTop: 8 }}>
              ✓ {sentCount} pesan dibuka &amp; ditandai terkirim manual.
              {skipped.length > 0 && <><br />Dilewati: {skipped.join(', ')}</>}
            </div>
            {failedMarks.length > 0 && (
              <div className="al-err" style={{ marginTop: 10 }}>
                ⚠ Stempel gagal untuk: {failedMarks.join(' · ')}<br />
                Jika chat WhatsApp-nya sempat terbuka dan terkirim, JANGAN kirim ulang —
                periksa dulu di riwayat chat pengirim.
              </div>
            )}
            <div className="al-mbtns">
              <button type="button" className="al-btn primary" onClick={onClose}>Tutup</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stepper, setStepper] = useState<LedgerRow[] | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

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
  }, [q, status, refreshTick]);

  // A new result set invalidates ticks that may no longer be visible/eligible.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set((data?.rows ?? []).filter(stepperEligible).map((r) => r.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const eligibleRows = useMemo(() => (data?.rows ?? []).filter(stepperEligible), [data]);
  const allTicked = eligibleRows.length > 0 && eligibleRows.every((r) => selected.has(r.id));

  function toggleAll() {
    setSelected(allTicked ? new Set() : new Set(eligibleRows.map((r) => r.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

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
        .al-check { width: 17px; height: 17px; accent-color: var(--nawilis, #0a3d8f); cursor: pointer; }
        .al-bulkbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; gap: 10px; justify-content: center; align-items: center; padding: 12px 16px; background: #fff; border-top: 1px solid #e3e9f2; box-shadow: 0 -4px 16px rgba(10,61,143,.14); flex-wrap: wrap; }
        .al-btn { padding: 9px 16px; border-radius: 8px; border: 1px solid #ccd5e3; background: #fff; font-size: 13.5px; font-weight: 700; cursor: pointer; }
        .al-btn.primary { background: var(--nawilis, #0a3d8f); border-color: var(--nawilis, #0a3d8f); color: #fff; }
        .al-btn:disabled { opacity: .55; cursor: default; }
        .al-ovr { position: fixed; inset: 0; z-index: 90; background: rgba(10, 20, 40, .45); display: flex; align-items: center; justify-content: center; padding: 16px; }
        .al-modal { background: #fff; border-radius: 12px; max-width: 480px; width: 100%; padding: 18px; max-height: 85vh; overflow-y: auto; }
        .al-mtitle { font-size: 17px; font-weight: 900; color: var(--nawilis, #0a3d8f); }
        .al-msg { margin-top: 10px; padding: 10px; background: #f4f6fb; border-radius: 8px; font-size: 12px; white-space: pre-wrap; max-height: 220px; overflow-y: auto; font-family: inherit; }
        .al-msgedit { display: block; width: 100%; border: 1px solid #ccd5e3; resize: vertical; line-height: 1.45; }
        .al-msgedit:disabled { opacity: .6; }
        .al-mbtns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
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
              <th style={{ width: 30 }}>
                {eligibleRows.length > 0 && (
                  <input
                    type="checkbox"
                    className="al-check"
                    checked={allTicked}
                    onChange={toggleAll}
                    title="Pilih semua yang belum terkirim"
                  />
                )}
              </th>
              <th>Tanggal</th>
              <th>Kendaraan / Customer</th>
              <th>Cabang</th>
              <th>Status WA</th>
              <th>Dikirim</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr><td colSpan={6} className="al-empty">Memuat…</td></tr>
            )}
            {data && data.rows.length === 0 && !loading && (
              <tr><td colSpan={6} className="al-empty">Tidak ada dokumen yang cocok.</td></tr>
            )}
            {data?.rows.map((r) => {
              const badge = r.mode ? MODE_BADGE[r.mode] : null;
              return (
                <tr key={r.id}>
                  <td>
                    {stepperEligible(r) && (
                      <input
                        type="checkbox"
                        className="al-check"
                        checked={selected.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                      />
                    )}
                  </td>
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

      {selected.size > 0 && !stepper && (
        <div className="al-bulkbar">
          <button
            type="button"
            className="al-btn primary"
            onClick={() => setStepper((data?.rows ?? []).filter((r) => selected.has(r.id)))}
          >
            📱 Kirim manual satu-satu — {selected.size} customer
          </button>
          <button type="button" className="al-btn" onClick={() => setSelected(new Set())}>Batal</button>
        </div>
      )}

      {stepper && (
        <ManualStepper
          targets={stepper}
          onClose={() => {
            setStepper(null);
            setSelected(new Set());
            setRefreshTick((t) => t + 1); // pull fresh stamps + chip counts
          }}
          onSent={(id) => setData((prev) => prev === null ? prev : ({
            ...prev,
            rows: prev.rows.map((r) => (r.id === id ? { ...r, mode: 'manual', by: 'alerts-ledger-manual', at: new Date().toISOString() } : r)),
          }))}
        />
      )}
    </main>
  );
}
