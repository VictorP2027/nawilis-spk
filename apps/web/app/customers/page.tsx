'use client';

import { useEffect, useRef, useState } from 'react';
import { BRANCHES } from '../../lib/refdata.client';

/**
 * /customers — helper pendaftaran customer Turboly (via robot RPA).
 *
 * Dua mode:
 *  - Retail    : customer perorangan (default; semua order servis adalah retail).
 *  - Corporate : perusahaan (wholesale) DIDAFTARKAN DULU, lalu customer retail
 *                (orang/PIC yang datang) dibuat terhubung ke perusahaan itu.
 *
 * Submit → POST /api/flow/action → { jobId }; lalu poll /api/flow/state sampai
 * job selesai/gagal. Registrasi dijalankan serial oleh worker (1 sesi Turboly).
 */

type Tab = 'retail' | 'corporate';
type Phase = 'idle' | 'sending' | 'queued' | 'running' | 'done' | 'failed' | 'unknown';

interface FlowJobView {
  _id: string;
  action?: string;
  state?: string;
  error?: string | null;
  result?: unknown;
}

interface ActionPayload {
  action: 'register_customer_retail' | 'register_customer_wholesale';
  params: Record<string, unknown>;
}

/**
 * /api/flow/state adalah endpoint papan-flow — bentuk persisnya milik modul lain.
 * Cari job berdasarkan _id di array manapun pada respons (kedalaman ≤ 2) supaya
 * halaman ini tidak bergantung pada nama key ('jobs' / 'flowJobs' / dst).
 */
function findJob(body: unknown, id: string, depth = 0): FlowJobView | null {
  if (!body || typeof body !== 'object' || depth > 2) return null;
  if (Array.isArray(body)) {
    for (const it of body) {
      if (it && typeof it === 'object' && (it as { _id?: unknown })._id === id) return it as FlowJobView;
      const deep = findJob(it, id, depth + 1);
      if (deep) return deep;
    }
    return null;
  }
  for (const v of Object.values(body as Record<string, unknown>)) {
    const hit = findJob(v, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Tampilkan hasil job (id/url customer dari robot) tanpa asumsi bentuk pasti. */
function renderResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['customerNo', 'customerId', 'customerUrl', 'wholesaleId', 'wholesaleUrl', 'retailId', 'retailUrl', 'url']) {
      const v = r[k];
      if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}: ${v}`);
    }
    if (parts.length) return parts.join(' · ');
    try { return JSON.stringify(result); } catch { return null; }
  }
  return String(result);
}

export default function Customers(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('retail');

  // ── Store pendaftaran (berlaku untuk kedua tab) ─────────────────────────
  const [branch, setBranch] = useState('');

  // ── Data orang (retail — juga PIC yang datang pada mode corporate) ──────
  const [nama, setNama] = useState('');
  const [wa, setWa] = useState('');
  const [alamat, setAlamat] = useState('');

  // ── Data perusahaan (corporate / wholesale) ─────────────────────────────
  const [coName, setCoName] = useState('');
  const [coPic, setCoPic] = useState('');
  const [coNpwp, setCoNpwp] = useState('');
  const [coAlamat, setCoAlamat] = useState('');
  const [coAdvisor, setCoAdvisor] = useState('');
  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);

  // ── Job state ───────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<ActionPayload | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  const seenRef = useRef(false); // job pernah terlihat di /api/flow/state
  const missRef = useRef(0); // poll berturut-turut tanpa menemukan job

  // Restore cabang yang diingat perangkat (key sama dengan form intake).
  useEffect(() => {
    setBranch(localStorage.getItem('branch') ?? '');
  }, []);
  useEffect(() => {
    if (branch) localStorage.setItem('branch', branch);
  }, [branch]);

  // Sales advisor cabang (wajib untuk wholesale) — daftar dari Turboly.
  useEffect(() => {
    if (!branch) { setAdvisors([]); return; }
    let live = true;
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`).then((r) => r.json())
      .then((d) => { if (live) setAdvisors(d.advisors ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [branch]);

  // Detik berjalan selama job aktif (feedback "robot sedang bekerja").
  const active = phase === 'sending' || phase === 'queued' || phase === 'running' || phase === 'unknown';
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // ── Polling /api/flow/state ─────────────────────────────────────────────
  useEffect(() => {
    if (!jobId || !active || phase === 'sending') return;
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/flow/state');
        if (!res.ok) return; // transien — coba lagi di tick berikutnya
        const body: unknown = await res.json().catch(() => null);
        if (!live || !body) return;
        const j = findJob(body, jobId);
        if (j) {
          seenRef.current = true;
          missRef.current = 0;
          const st = (j.state ?? '').toLowerCase();
          if (st === 'failed') {
            setJobError(j.error || 'Job gagal tanpa pesan error.');
            setPhase('failed');
          } else if (st === 'done') {
            setJobResult(renderResult(j.result));
            setPhase('done');
          } else if (st === 'running') {
            setPhase('running');
          } else {
            setPhase('queued');
          }
        } else if (seenRef.current) {
          // Board hanya menampilkan job pending/failed — hilang dari daftar
          // setelah terlihat = sudah selesai diproses.
          setPhase('done');
        } else {
          missRef.current += 1;
          if (missRef.current >= 5) setPhase('unknown'); // tetap di-poll — kalau nanti muncul failed, tertangkap
        }
      } catch {
        /* offline / transien — biarkan tick berikutnya mencoba lagi */
      }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => { live = false; clearInterval(t); };
  }, [jobId, active, phase]);

  // ── Validasi (pola sama dengan form intake "/") ─────────────────────────
  const waDigits = wa.replace(/\D/g, '');
  const waNat = waDigits.replace(/^62/, '').replace(/^0/, '');
  const waOk = /^8\d{8,11}$/.test(waNat);
  const waE164 = waOk ? `+62${waNat}` : null;

  const namaOk = nama.trim() !== '';
  const alamatOk = alamat.trim() !== '';
  const branchOk = branch !== '';

  const coNameOk = coName.trim() !== '';
  const coPicOk = coPic.trim() !== '';
  const coNpwpDigits = coNpwp.replace(/\D/g, '');
  const coNpwpOk = coNpwp.trim() !== '';
  const coNpwpOdd = coNpwpOk && !(coNpwpDigits.length === 15 || coNpwpDigits.length === 16);
  const coAlamatOk = coAlamat.trim() !== '';
  const coAdvisorOk = coAdvisor.trim() !== '';
  const advisorUnknown = coAdvisor.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === coAdvisor.trim().toUpperCase());

  const retailValid = branchOk && namaOk && waOk && alamatOk;
  const canSubmit = (tab === 'retail' ? retailValid : retailValid && coNameOk && coPicOk && coNpwpOk && coAlamatOk && coAdvisorOk) && !active;

  function buildPayload(): ActionPayload {
    const retailParams = { nama: nama.trim(), phone: waE164, alamat: alamat.trim(), branchCode: branch };
    if (tab === 'retail') {
      return { action: 'register_customer_retail', params: retailParams };
    }
    return {
      action: 'register_customer_wholesale',
      params: {
        company: {
          companyName: coName.trim(),
          picName: coPic.trim(),
          npwp: coNpwp.trim(),
          alamat: coAlamat.trim(),
          advisorName: coAdvisor.trim(),
        },
        retail: retailParams,
      },
    };
  }

  async function submit(payload?: ActionPayload): Promise<void> {
    const p = payload ?? buildPayload();
    setLastPayload(p);
    setPhase('sending');
    setJobId(null);
    setJobError(null);
    setJobResult(null);
    seenRef.current = false;
    missRef.current = 0;
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const res = await fetch('/api/flow/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      });
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 401 || res.status === 403) {
        setJobError('Sesi login habis — silakan login ulang lalu coba lagi.');
        setPhase('failed');
        return;
      }
      const id = typeof (body as { jobId?: unknown }).jobId === 'string' ? (body as { jobId: string }).jobId : null;
      if (!res.ok || !id) {
        setJobError(typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `Gagal mengirim job (HTTP ${res.status}).`);
        setPhase('failed');
        return;
      }
      setJobId(id);
      setPhase('queued');
    } catch {
      setJobError('Tidak bisa terhubung ke server — periksa koneksi lalu coba lagi.');
      setPhase('failed');
    }
  }

  function retry(): void {
    if (lastPayload) void submit(lastPayload);
  }

  function resetForNext(): void {
    setPhase('idle');
    setJobId(null);
    setLastPayload(null);
    setJobError(null);
    setJobResult(null);
    setNama('');
    setWa('');
    setAlamat('');
    setCoName('');
    setCoPic('');
    setCoNpwp('');
    setCoAlamat('');
    setCoAdvisor('');
  }

  const elapsed = fmtElapsed(now - startedAt);
  const slow = active && startedAt > 0 && now - startedAt > 5 * 60_000;
  const actionLabel = (lastPayload?.action ?? (tab === 'retail' ? 'register_customer_retail' : 'register_customer_wholesale')) === 'register_customer_retail'
    ? 'Retail'
    : 'Corporate (Wholesale + Retail)';

  return (
    <>
      <div className="topbar">
        <span className="brand">NAWILIS · CUSTOMER BARU</span>
        <span className="branch">{BRANCHES.find((b) => b.code === branch)?.name ?? 'Pilih store'}</span>
      </div>
      <div className="wrap">
        {/* ── Pilih jenis customer ── */}
        <div className="tiles" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 14 }}>
          <button type="button" className={`tile ${tab === 'retail' ? 'on' : ''}`} onClick={() => setTab('retail')} disabled={active}>
            Retail
            <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Perorangan — default untuk servis</span>
          </button>
          <button type="button" className={`tile ${tab === 'corporate' ? 'on' : ''}`} onClick={() => setTab('corporate')} disabled={active}>
            Corporate
            <span style={{ display: 'block', fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Perusahaan (wholesale) + orang PIC</span>
          </button>
        </div>

        {/* ── Store pendaftaran ── */}
        <div className="card">
          <div className="label">Store pendaftaran</div>
          <select value={branch} onChange={(e) => setBranch(e.target.value)} style={!branchOk ? { borderColor: '#dc2626' } : undefined}>
            <option value="">— pilih store —</option>
            {BRANCHES.map((b) => (
              <option key={b.code} value={b.code}>{b.name}</option>
            ))}
          </select>
          {!branchOk && <div className="req-note">⚠ wajib — store tempat customer pertama kali didaftarkan</div>}
          {branchOk && <div className="ok-sm">✓ Store pendaftaran pertama melekat permanen pada customer di Turboly.</div>}
        </div>

        {/* ── Data perusahaan (corporate saja) ── */}
        {tab === 'corporate' && (
          <div className="card">
            <div className="label">Perusahaan (wholesale) — didaftarkan lebih dulu</div>
            <input value={coName} onChange={(e) => setCoName(e.target.value)} placeholder="Nama perusahaan — WAJIB" style={!coNameOk ? { borderColor: '#dc2626' } : undefined} />
            {!coNameOk && <div className="req-note">⚠ wajib diisi</div>}
            <div className="row" style={{ marginTop: 10 }}>
              <div>
                <input value={coPic} onChange={(e) => setCoPic(e.target.value)} placeholder="PIC (penanggung jawab) — WAJIB" style={!coPicOk ? { borderColor: '#dc2626' } : undefined} />
                {!coPicOk && <div className="req-note">⚠ wajib diisi</div>}
              </div>
              <div>
                <input value={coNpwp} onChange={(e) => setCoNpwp(e.target.value)} inputMode="numeric" placeholder="NPWP — WAJIB" style={!coNpwpOk ? { borderColor: '#dc2626' } : coNpwpOdd ? { borderColor: '#d97706' } : undefined} />
                {!coNpwpOk && <div className="req-note">⚠ wajib diisi</div>}
                {coNpwpOdd && <div className="warn-note">⚠ NPWP biasanya 15–16 digit — periksa lagi, boleh lanjut.</div>}
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <input value={coAlamat} onChange={(e) => setCoAlamat(e.target.value)} placeholder="Alamat perusahaan — WAJIB" style={!coAlamatOk ? { borderColor: '#dc2626' } : undefined} />
              {!coAlamatOk && <div className="req-note">⚠ wajib diisi</div>}
            </div>
            <div className="label" style={{ marginTop: 12 }}>Sales advisor</div>
            <input list="cust-advisor-list" value={coAdvisor} onChange={(e) => setCoAdvisor(e.target.value)} placeholder={advisors.length ? 'Pilih dari daftar / ketik' : 'Nama sales advisor'} style={!coAdvisorOk ? { borderColor: '#dc2626' } : advisorUnknown ? { borderColor: '#d97706' } : undefined} />
            <datalist id="cust-advisor-list">{advisors.map((a) => <option key={a.code} value={a.name} />)}</datalist>
            {!coAdvisorOk && <div className="req-note">⚠ wajib — Turboly minta sales advisor untuk customer wholesale</div>}
            {advisorUnknown && <div className="warn-note">⚠ Tidak ada di daftar advisor store ini — harus sama persis dengan nama di Turboly.</div>}
            <div className="ok-sm" style={{ color: '#55627a' }}>Currency IDR &amp; pajak PPN diisi otomatis oleh robot.</div>
          </div>
        )}

        {/* ── Data orang (retail) ── */}
        <div className="card">
          <div className="label">{tab === 'corporate' ? 'Orang yang datang (customer retail, terhubung ke perusahaan)' : 'Data customer'}</div>
          <input value={nama} onChange={(e) => setNama(e.target.value)} placeholder="Nama — WAJIB" style={!namaOk ? { borderColor: '#dc2626' } : undefined} />
          {!namaOk && <div className="req-note">⚠ wajib diisi</div>}
          <div style={{ marginTop: 10 }}>
            <div className="label">Nomor WhatsApp — identitas pelanggan</div>
            <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="08…" style={!waOk ? { borderColor: '#dc2626' } : undefined} />
            {!waOk && <div className="req-note">⚠ wajib — format Indonesia 08… / +62 8…, contoh 08123456789</div>}
            {waOk && <div className="ok-sm">✓ {waE164}</div>}
          </div>
          <div style={{ marginTop: 10 }}>
            <input value={alamat} onChange={(e) => setAlamat(e.target.value)} placeholder="Alamat lengkap — WAJIB" style={!alamatOk ? { borderColor: '#dc2626' } : undefined} />
            {!alamatOk && <div className="req-note">⚠ wajib — tulis alamat lengkap (tanpa pilih area/wilayah)</div>}
          </div>
          <div className="ok-sm" style={{ color: '#55627a', marginTop: 6 }}>Service Tax PPN (&quot;Always use Tax&quot;) diisi otomatis oleh robot.</div>
        </div>

        {/* ── Status job ── */}
        {phase !== 'idle' && (
          <div className="card">
            <div className="label">Status pendaftaran — {actionLabel}</div>
            {phase === 'sending' && <div className="finding WARN">⏳ Mengirim ke antrean robot…</div>}
            {phase === 'queued' && <div className="finding WARN">⏳ Dalam antrean robot ({elapsed}) — biasanya mulai dalam 1–3 menit.</div>}
            {phase === 'running' && <div className="finding WARN">🤖 Robot sedang mendaftarkan di Turboly… ({elapsed})</div>}
            {phase === 'unknown' && (
              <div className="warn-note">⚠ Job terkirim (ID {jobId}) tetapi belum terlihat di daftar antrean ({elapsed}). Kemungkinan sudah selesai diproses — periksa Customers di Turboly sebelum mengirim ulang (hindari dobel daftar).</div>
            )}
            {phase === 'done' && (
              <>
                <div className="finding WARN" style={{ background: '#e6f4ea', color: '#157a3c' }}>
                  ✓ Selesai — customer {actionLabel.toLowerCase()} berhasil diproses robot.{jobResult ? ` (${jobResult})` : ''}
                </div>
                <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={resetForNext}>+ Daftarkan customer lain</button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <div className="finding BLOCK">✗ Gagal: {jobError ?? 'tanpa pesan error'}</div>
                {jobError?.includes('login') && (
                  <div className="warn-note">Buka <a href="/login">halaman login</a> lalu kembali ke sini.</div>
                )}
                <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={retry}>↻ Coba lagi</button>
              </>
            )}
            {slow && (
              <div className="warn-note">⚠ Lebih lama dari biasanya ({elapsed}). Antrean robot berjalan serial — job lain mungkin sedang diproses. Halaman ini terus memantau otomatis.</div>
            )}
            {jobId && phase !== 'done' && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>Job: {jobId}</div>}
          </div>
        )}

        <button className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
          {active
            ? 'Sedang diproses…'
            : tab === 'retail'
              ? 'Daftarkan Customer Retail'
              : 'Daftarkan Perusahaan + Customer'}
        </button>

        <div className="sync" style={{ marginTop: 12, textAlign: 'center', color: 'var(--muted)' }}>
          <a href="/">Form SPK</a>
          {' · '}
          <a href="/checkgo">Check &amp; Go</a>
          {' · '}
          <a href="/flow">Papan Flow</a>
        </div>
      </div>
    </>
  );
}
