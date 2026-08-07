'use client';

import BrandMark from './../components/BrandMark';
import { useEffect, useState, useCallback } from 'react';

interface Summary {
  byState: Record<string, number>;
  byBranch: Array<{ _id: string; captured: number; confirmed: number }>;
  dlqOpen: number;
  degradation: { rung: number; reason?: string; since?: string };
  lastRecon: { ranAt: string; missingInTurboly: string[]; extraWithOurToken: string[]; stuck: number } | null;
  ageAlerts: { queuedStale: number; pushingStale: number; reviewStale: number; manualStale: number };
}

interface Row {
  _id: string;
  branchCode: string;
  state: string;
  customer: { nama: string };
  vehicle: { noPolisi: { display: string } };
  jobLineSummary: { orderedCount: number; quotedTotal: number };
  turboly: { serviceOrderNo: string | null };
  push?: { lastError?: string | null; failureClass?: string | null };
  signatures?: {
    menyerahkan?: { imageDataUrl?: string | null };
    menerima?: { imageDataUrl?: string | null };
  };
}

/** Tiny inline signature thumbnail; click opens the full-size PNG in a new tab. */
function SigThumb({ src, title }: { src?: string | null; title: string }) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={title}
      title={title}
      style={{ height: 26, maxWidth: 90, objectFit: 'contain', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 4, marginRight: 4, cursor: 'pointer', verticalAlign: 'middle' }}
      onClick={() => { const w = window.open(); w?.document.write(`<title>${title}</title><img src="${src}" style="border:1px solid #ccc">`); }}
    />
  );
}

const RUNG_LABEL = ['0 · Full auto', '1 · Sampled audit', '2 · Assisted entry', '3 · Manual'];

interface DbUsage {
  dbName: string;
  collections: Array<{ name: string; count: number; dataBytes: number; storageBytes: number; indexBytes: number }>;
  totals: { dataBytes: number; storageBytes: number; indexBytes: number };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

interface WaStatus {
  known: boolean;
  session?: string;
  status?: { mode?: string; sessionStatus?: string; error?: string | null };
  qrDataUrl?: string | null;
  updatedAt?: string;
  stale?: boolean;
}

export default function Admin() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [awaiting, setAwaiting] = useState<Row[]>([]);
  const [all, setAll] = useState<Row[]>([]);
  const [mech, setMech] = useState('');
  const [usage, setUsage] = useState<DbUsage | null>(null);
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [purging, setPurging] = useState(false);

  const loadUsage = useCallback(async () => {
    try { setUsage(await fetch('/api/admin/db-usage').then((r) => r.json())); } catch { /* panel stays empty */ }
    try { setWa(await fetch('/api/admin/wa-status').then((r) => r.json())); } catch { /* ditto */ }
  }, []);

  /**
   * Wipe everything the branches produced — AFTER the backup is on the
   * admin's own disk. Reference mirrors are untouchable from here by design.
   */
  async function purgeAll() {
    setPurging(true);
    try {
      // 1. Backup lands locally first, always.
      const blob = await fetch('/api/admin/purge').then((r) => r.blob());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spk-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      // 2. The deletion needs the word typed, not a reflex OK.
      const typed = prompt('Backup sudah terunduh.\n\nKetik HAPUS untuk menghapus data operasional (SPK, events, antrean).\nRiwayat customer/kendaraan dan data referensi TIDAK ikut terhapus.');
      if (typed !== 'HAPUS') return;
      const res = await fetch('/api/admin/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'HAPUS' }) });
      const out = await res.json();
      alert(res.ok ? `Terhapus: ${Object.entries(out.deleted).map(([k, v]) => `${k} ${v}`).join(', ')}` : out.message ?? 'Gagal.');
      await Promise.all([load(), loadUsage()]);
    } finally {
      setPurging(false);
    }
  }

  const load = useCallback(async () => {
    const [s, a, everything] = await Promise.all([
      fetch('/api/admin/summary').then((r) => r.json()),
      fetch('/api/spk?state=awaiting_assignment').then((r) => r.json()),
      fetch('/api/spk').then((r) => r.json()),
    ]);
    setSum(s);
    setAwaiting(a.rows ?? []);
    setAll(everything.rows ?? []);
  }, []);

  async function del(id: string) {
    if (!confirm('Hapus SPK ini?')) return;
    await fetch(`/api/spk/${id}`, { method: 'DELETE' });
    await load();
  }

  async function retry(id: string) {
    await fetch(`/api/spk/${id}/retry`, { method: 'POST' });
    await load();
  }

  useEffect(() => {
    void load();
    void loadUsage();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, loadUsage]);

  async function assign(id: string) {
    if (!mech) {
      alert('Isi kode mekanik dulu (mensimulasikan scan tiket QR).');
      return;
    }
    await fetch(`/api/spk/${id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mechanicCode: mech, by: 'console', via: 'console' }),
    });
    await load();
  }
  async function voidSpk(id: string) {
    await fetch(`/api/spk/${id}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'console', reason: 'declined' }) });
    await load();
  }

  const s = sum;
  return (
    <>
      <div className="topbar">
        <BrandMark page="DASHBOARD" />
        <span className="branch">{s ? RUNG_LABEL[s.degradation.rung] : '…'}</span>
      </div>
      <div className="wrap" style={{ maxWidth: 1000 }}>
        {s && (
          <>
            <div className="grid4">
              <Stat k="Awaiting mechanic" n={s.byState['awaiting_assignment'] ?? 0} />
              <Stat k="Queued → Turboly" n={s.byState['queued'] ?? 0} />
              <Stat k="Confirmed" n={s.byState['confirmed'] ?? 0} />
              <Stat k="DLQ open" n={s.dlqOpen} alert={s.dlqOpen > 0} />
            </div>
            <div className="grid4" style={{ marginTop: 12 }}>
              <Stat k="Needs review" n={s.byState['needs_review'] ?? 0} />
              <Stat k="Pushing" n={s.byState['pushing'] ?? 0} />
              <Stat k="Failed" n={s.byState['failed'] ?? 0} alert={(s.byState['failed'] ?? 0) > 0} />
              <Stat k="Manual" n={s.byState['manual_intervention'] ?? 0} alert={(s.byState['manual_intervention'] ?? 0) > 0} />
            </div>

            {s.lastRecon && (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="label">Rekonsiliasi terakhir · {new Date(s.lastRecon.ranAt).toLocaleString('id-ID')}</div>
                <div>
                  <span className={`badge ${s.lastRecon.extraWithOurToken.length ? 'red' : 'green'}`}>double-push: {s.lastRecon.extraWithOurToken.length}</span>{' '}
                  <span className={`badge ${s.lastRecon.missingInTurboly.length ? 'yellow' : 'green'}`}>missing: {s.lastRecon.missingInTurboly.length}</span>{' '}
                  <span className={`badge ${s.lastRecon.stuck ? 'yellow' : 'green'}`}>stuck: {s.lastRecon.stuck}</span>
                </div>
              </div>
            )}
          </>
        )}

        <div className="card">
          <div className="label">Export (format Nawilis .xlsx)</div>
          <div className="row" style={{ gap: 10 }}>
            <a className="btn primary" style={{ textAlign: 'center', textDecoration: 'none' }} href="/api/export?scope=used">⬇ Export dipakai di Service Order</a>
            <a className="btn ghost" style={{ textAlign: 'center', textDecoration: 'none' }} href="/api/export?scope=all">⬇ Export semua (raw)</a>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            "Dipakai di Service Order" = SPK yang sudah ditugaskan ke mekanik. Tambah <code>&outlet=NWL-PRG&from=2026-04-01&to=2026-04-11</code> untuk filter.
          </div>
        </div>

        <div className="card">
          <div className="label">Menunggu ditugaskan ke mekanik (belum dikirim ke Turboly)</div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input value={mech} onChange={(e) => setMech(e.target.value)} placeholder="Kode mekanik (simulasi scan tiket)" />
          </div>
          <table>
            <thead>
              <tr><th>Plat</th><th>Customer</th><th>Cabang</th><th>Pekerjaan</th><th>Estimasi</th><th></th></tr>
            </thead>
            <tbody>
              {awaiting.map((r) => (
                <tr key={r._id}>
                  <td>{r.vehicle.noPolisi.display}</td>
                  <td>{r.customer.nama}</td>
                  <td>{r.branchCode}</td>
                  <td>{r.jobLineSummary.orderedCount} item</td>
                  <td>Rp {r.jobLineSummary.quotedTotal.toLocaleString('id-ID')}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost" style={{ padding: '6px 10px', fontSize: 14 }} onClick={() => assign(r._id)}>Tugaskan →</button>{' '}
                    <button className="btn ghost" style={{ padding: '6px 10px', fontSize: 14 }} onClick={() => voidSpk(r._id)}>Batal</button>
                  </td>
                </tr>
              ))}
              {awaiting.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>Tidak ada.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="label">Semua SPK (terbaru) — bisa dihapus</div>
          <table>
            <thead>
              <tr><th>Plat</th><th>Customer</th><th>Cabang</th><th>Status</th><th>SO No.</th><th></th></tr>
            </thead>
            <tbody>
              {all.map((r) => (
                <tr key={r._id}>
                  <td>{r.vehicle.noPolisi.display}</td>
                  <td>
                    {r.customer.nama}
                    <SigThumb src={r.signatures?.menyerahkan?.imageDataUrl} title={`Tanda tangan customer — ${r.customer.nama}`} />
                    <SigThumb src={r.signatures?.menerima?.imageDataUrl} title="Tanda tangan penerima (SA)" />
                  </td>
                  <td>{r.branchCode}</td>
                  <td>
                    <StateBadge state={r.state} />
                    {r.state === 'failed' && r.push?.lastError && (
                      <div style={{ fontSize: 11, color: '#b45309', maxWidth: 260, marginTop: 2 }}>{r.push.lastError}</div>
                    )}
                  </td>
                  <td>{r.turboly?.serviceOrderNo ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.state === 'failed' && (
                      <button className="btn ghost" style={{ padding: '6px 10px', fontSize: 14, marginRight: 6 }} onClick={() => retry(r._id)}>↻ Coba lagi</button>
                    )}
                    <button className="btn ghost" style={{ padding: '6px 10px', fontSize: 14, color: 'var(--block)' }} onClick={() => del(r._id)}>Hapus</button>
                  </td>
                </tr>
              ))}
              {all.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>Belum ada SPK.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="label">WhatsApp Gateway (pengirim hasil Check &amp; Go)</div>
          {!wa || !wa.known ? (
            <div style={{ color: 'var(--muted)' }}>Belum ada status — watcher belum pernah lapor.</div>
          ) : (
            <>
              <div>
                {wa.stale ? (
                  <span className="badge red">WATCHER MATI — status terakhir {wa.updatedAt ? new Date(wa.updatedAt).toLocaleTimeString('id-ID') : '?'}</span>
                ) : wa.status?.mode === 'live' ? (
                  <span className="badge green">TERSAMBUNG · siap kirim</span>
                ) : wa.qrDataUrl ? (
                  <span className="badge yellow">PERLU PAIRING — scan QR di bawah</span>
                ) : (
                  <span className="badge yellow">{wa.status?.sessionStatus ?? 'TIDAK SIAP'}{wa.status?.error ? ` — ${wa.status.error}` : ''}</span>
                )}
              </div>
              {wa.qrDataUrl && !wa.stale && (
                <div style={{ marginTop: 10 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={wa.qrDataUrl} alt="QR pairing WhatsApp" style={{ width: 240, height: 240, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, maxWidth: 420 }}>
                    Di HP <b>pengirim</b>: WhatsApp → <b>Perangkat tertaut</b> → <b>Tautkan perangkat</b> → scan QR ini.
                    Cukup sekali; sesi bertahan. QR diperbarui otomatis oleh watcher setiap ±30 detik.
                  </div>
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                Pesan dikirim oleh satu komputer gateway. Halaman ini hanya menampilkan status &amp; QR-nya —
                siapa pun bisa pairing dari sini tanpa menyentuh komputer itu.
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="label">MongoDB · {usage?.dbName ?? '…'}</div>
          {usage ? (
            <>
              <table>
                <thead>
                  <tr><th>Koleksi</th><th style={{ textAlign: 'right' }}>Dokumen</th><th style={{ textAlign: 'right' }}>Data</th><th style={{ textAlign: 'right' }}>Disk</th><th style={{ textAlign: 'right' }}>Index</th></tr>
                </thead>
                <tbody>
                  {usage.collections.filter((c) => c.count > 0 || c.dataBytes > 0).map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td style={{ textAlign: 'right' }}>{c.count.toLocaleString('id-ID')}</td>
                      <td style={{ textAlign: 'right' }}>{mb(c.dataBytes)}</td>
                      <td style={{ textAlign: 'right' }}>{mb(c.storageBytes)}</td>
                      <td style={{ textAlign: 'right' }}>{mb(c.indexBytes)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}>
                    <td>TOTAL</td><td />
                    <td style={{ textAlign: 'right' }}>{mb(usage.totals.dataBytes)}</td>
                    <td style={{ textAlign: 'right' }}>{mb(usage.totals.storageBytes)}</td>
                    <td style={{ textAlign: 'right' }}>{mb(usage.totals.indexBytes)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
                <button className="btn ghost" style={{ color: 'var(--block)' }} disabled={purging} onClick={() => void purgeAll()}>
                  {purging ? 'Memproses…' : '🗑 Hapus SEMUA data operasional (backup dulu)'}
                </button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Backup JSON terunduh otomatis sebelum hapus. Riwayat customer/kendaraan dan data referensi (stores, mekanik, katalog, SKU map) tidak tersentuh.
                </span>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--muted)' }}>Memuat…</div>
          )}
        </div>

        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <a href="/">← Intake (ringkas)</a> &nbsp;·&nbsp; <a href="/sheet">Form SPK (lembar)</a>
        </div>
      </div>
    </>
  );
}

function StateBadge({ state }: { state: string }) {
  const color =
    state === 'confirmed' ? 'green' :
    state === 'awaiting_assignment' ? 'blue' :
    state === 'needs_review' ? 'yellow' :
    state === 'failed' || state === 'manual_intervention' ? 'red' : 'gray';
  return <span className={`badge ${color}`}>{state}</span>;
}

function Stat({ k, n, alert }: { k: string; n: number; alert?: boolean }) {
  return (
    <div className="stat" style={alert ? { borderColor: 'var(--block)' } : undefined}>
      <div className="n" style={alert ? { color: 'var(--block)' } : undefined}>{n}</div>
      <div className="k">{k}</div>
    </div>
  );
}
