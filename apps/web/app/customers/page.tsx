'use client';

import BrandMark from './../components/BrandMark';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRANCHES } from '../../lib/refdata.client';
import { useBranches } from '../../lib/branches.client';

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
 *
 * STATUS TAHAN RELOAD. Kartu status dulu hanya hidup di state komponen: reload
 * (atau HP terkunci) menghapus fakta bahwa pendaftaran sedang berjalan, operator
 * submit lagi → customer dobel, kegagalan terburuk sistem ini. Sekarang jobId
 * yang dikirim disimpan di localStorage, di-rehydrate saat mount, dan status
 * sebenarnya ditanyakan ulang ke /api/flow/state (endpoint yang sama dengan
 * papan flow). Riwayat singkat "Pendaftaran terakhir" membuat tab yang telanjur
 * ditutup tetap berakhir dengan jawaban.
 *
 * CATATAN JENDELA PANTAU: /api/flow/state hanya mengembalikan job queued/running/
 * failed + job 'done' yang selesai <15 menit terakhir. Job yang hilang dari
 * daftar TIDAK boleh diklaim berhasil — ditandai "tidak pasti" dan operator
 * diminta memeriksa Turboly, bukan mengirim ulang.
 */

type Tab = 'retail' | 'corporate';
type Phase = 'idle' | 'sending' | 'queued' | 'running' | 'done' | 'failed' | 'unknown';
type RegState = 'queued' | 'running' | 'done' | 'failed' | 'unknown';

interface FlowJobView {
  _id?: string;
  jobId?: string;
  action?: string;
  state?: string;
  error?: string | null;
  result?: unknown;
  createdAt?: string;
  updatedAt?: string | null;
}

interface ActionPayload {
  action: 'register_customer_retail' | 'register_customer_wholesale';
  params: Record<string, unknown>;
}

/** Satu percobaan pendaftaran yang diingat perangkat ini (localStorage). */
interface RegEntry {
  jobId: string | null; // null = gagal sebelum sempat masuk antrean
  action: string;
  label: string;
  createdAt: number; // ms
  state: RegState;
  error: string | null;
  result: string | null;
  payload: ActionPayload | null;
}

const LEDGER_KEY = 'cust_reg_jobs_v1';
const ACTIVE_KEY = 'cust_reg_active_v1';
const LEDGER_MAX = 8;
const RECENT_SHOWN = 5;
/** Sama dengan RECENT_DONE_JOBS_MS di /api/flow/state — batas job masih terlihat. */
const BOARD_WINDOW_MS = 15 * 60_000;
/** Kartu status hasil rehydrate lebih tua dari ini tidak dibuka lagi. */
const REHYDRATE_MAX_AGE_MS = 6 * 3600_000;
/** Poll cepat dulu (pendaftaran ditargetkan ~10 dtk), lalu mundur. */
const POLL_DELAYS = [900, 900, 1200, 1500, 2000, 2500, 3000, 4000, 5000] as const;
const POLL_STEADY = 6000;
const POLL_DEADLINE_MS = 15 * 60_000;
/** Umur maksimal penekanan "kegagalan basi" setelah Coba lagi (lihat pollOnce). */
const RETRY_MASK_MS = 20_000;

/**
 * /api/flow/state adalah endpoint papan-flow — bentuk persisnya milik modul lain.
 * Cari job di array manapun pada respons (kedalaman ≤ 2) supaya halaman ini
 * tidak bergantung pada nama key ('jobs' / 'flowJobs' / dst). Job brief di
 * endpoint itu memakai key `jobId` (bukan `_id`) — cocokkan KEDUANYA.
 */
function findJob(body: unknown, id: string, depth = 0): FlowJobView | null {
  if (!body || typeof body !== 'object' || depth > 2) return null;
  if (Array.isArray(body)) {
    for (const it of body) {
      if (it && typeof it === 'object') {
        const o = it as { _id?: unknown; jobId?: unknown };
        if (o._id === id || o.jobId === id) return it as FlowJobView;
      }
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

/** Semua job pendaftaran customer di respons — termasuk yang dikirim perangkat lain. */
function collectRegJobs(body: unknown, out: FlowJobView[] = [], depth = 0): FlowJobView[] {
  if (!body || typeof body !== 'object' || depth > 2) return out;
  if (Array.isArray(body)) {
    for (const it of body) {
      if (it && typeof it === 'object') {
        const o = it as FlowJobView;
        if (typeof o.jobId === 'string' && typeof o.action === 'string' && o.action.startsWith('register_customer')
          && !out.some((x) => x.jobId === o.jobId)) {
          out.push(o);
        }
      }
      collectRegJobs(it, out, depth + 1);
    }
    return out;
  }
  for (const v of Object.values(body as Record<string, unknown>)) collectRegJobs(v, out, depth + 1);
  return out;
}

function normState(s: unknown): RegState | null {
  const v = typeof s === 'string' ? s.toLowerCase() : '';
  return v === 'queued' || v === 'running' || v === 'done' || v === 'failed' || v === 'unknown' ? v : null;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtAgo(ts: number, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

/** Tampilkan hasil job (id/url customer dari robot) tanpa asumsi bentuk pasti. */
function renderResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['customerNo', 'customerId', 'customerUrl', 'companyId', 'companyUrl', 'wholesaleId', 'wholesaleUrl', 'retailId', 'retailUrl', 'url', 'note']) {
      const v = r[k];
      if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}: ${v}`);
    }
    if (parts.length) return parts.join(' · ');
    try { return JSON.stringify(result); } catch { return null; }
  }
  return String(result);
}

function actionShort(action: string): string {
  if (action === 'register_customer_retail') return 'Retail';
  if (action === 'register_customer_wholesale') return 'Corporate (Wholesale + Retail)';
  return 'Pendaftaran';
}

/** Label riwayat: siapa yang didaftarkan, dari payload yang kita kirim sendiri. */
function labelFor(p: ActionPayload): string {
  const pr = p.params;
  if (p.action === 'register_customer_retail') {
    const n = typeof pr.nama === 'string' ? pr.nama : '';
    const ph = typeof pr.phone === 'string' ? pr.phone : '';
    return [n, ph].filter(Boolean).join(' · ') || 'Customer retail';
  }
  const co = typeof pr.companyName === 'string' ? pr.companyName : '';
  const r = pr.retail && typeof pr.retail === 'object' ? (pr.retail as Record<string, unknown>) : {};
  const n = typeof r.nama === 'string' ? r.nama : '';
  return [co, n].filter(Boolean).join(' + ') || 'Customer corporate';
}

/** Nomor WA yang dipakai job ini — dasar peringatan "baru saja didaftarkan". */
function phoneOf(p: ActionPayload | null): string | null {
  if (!p) return null;
  const pr = p.params;
  if (typeof pr.phone === 'string') return pr.phone;
  const r = pr.retail && typeof pr.retail === 'object' ? (pr.retail as Record<string, unknown>) : {};
  return typeof r.phone === 'string' ? r.phone : null;
}

function readLedger(): RegEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RegEntry[] = [];
    for (const it of parsed) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const st = normState(o.state);
      if (!st) continue;
      out.push({
        jobId: typeof o.jobId === 'string' ? o.jobId : null,
        action: typeof o.action === 'string' ? o.action : '',
        label: typeof o.label === 'string' ? o.label : '(tanpa nama)',
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
        state: st,
        error: typeof o.error === 'string' ? o.error : null,
        result: typeof o.result === 'string' ? o.result : null,
        payload: o.payload && typeof o.payload === 'object' ? (o.payload as ActionPayload) : null,
      });
    }
    return out.slice(0, LEDGER_MAX);
  } catch {
    return [];
  }
}

function writeLedger(list: RegEntry[]): void {
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(list)); } catch { /* storage penuh / mode privat */ }
}

export default function Customers(): React.ReactElement {
  // Compiled-in list, plus any branch opened since the last deploy.
  const BRANCHES = useBranches();
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
  const [retryBusy, setRetryBusy] = useState<string | null>(null); // jobId yang sedang dikirim ulang
  const [authLost, setAuthLost] = useState(false);
  const [pollNonce, setPollNonce] = useState(0); // naikkan = mulai ulang jadwal poll (cepat lagi)
  const [ledger, setLedger] = useState<RegEntry[]>([]);
  const [serverJobs, setServerJobs] = useState<FlowJobView[]>([]);
  const seenRef = useRef(false); // job pernah terlihat di /api/flow/state
  const missRef = useRef(0); // poll berturut-turut tanpa menemukan job
  const jobStartRef = useRef(0); // kapan job ini dibuat/dicoba ulang (ms)
  const serverNowRef = useRef<string | null>(null); // jam SERVER dari poll terakhir
  const retryMarkerRef = useRef<string | null>(null); // jam server saat Coba lagi ditekan
  const retryMaskUntilRef = useRef(0); // batas waktu klien penekanan kegagalan basi

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

  const active = phase === 'sending' || phase === 'queued' || phase === 'running' || phase === 'unknown';

  // Detik berjalan selama job aktif; saat idle cukup pelan (untuk "x mnt lalu").
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), active ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [active]);

  // ── Riwayat lokal ───────────────────────────────────────────────────────
  const mutateLedger = useCallback((fn: (l: RegEntry[]) => RegEntry[]) => {
    setLedger((prev) => {
      const next = fn(prev);
      if (next === prev) return prev; // poll tiap detik: jangan tulis ulang kalau tidak berubah
      const capped = next.slice(0, LEDGER_MAX);
      writeLedger(capped);
      return capped;
    });
  }, []);

  const patchLedger = useCallback((id: string, patch: Partial<RegEntry>) => {
    mutateLedger((l) => {
      let changed = false;
      const next = l.map((e) => {
        if (e.jobId !== id) return e;
        const m = { ...e, ...patch };
        if (m.state === e.state && m.error === e.error && m.result === e.result) return e;
        changed = true;
        return m;
      });
      return changed ? next : l;
    });
  }, [mutateLedger]);

  const setActiveJob = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch { /* mode privat — kartu tetap jalan selama tab hidup */ }
  }, []);

  /**
   * Satu putaran poll. Mengembalikan 'stop' kalau status job sudah final, jadi
   * job hasil rehydrate pun tetap diverifikasi sekali ke server (kartu "gagal"
   * yang sebenarnya sudah dicoba ulang di perangkat lain tidak ikut basi).
   */
  const pollOnce = useCallback(async (id: string | null): Promise<'stop' | 'go'> => {
    let body: unknown = null;
    try {
      const res = await fetch('/api/flow/state', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { setAuthLost(true); return 'go'; }
      if (!res.ok) return 'go'; // transien — coba lagi di tick berikutnya
      body = await res.json().catch(() => null);
    } catch {
      return 'go'; // offline / transien
    }
    if (!body) return 'go';
    setAuthLost(false);

    const bodyNow = (body as { now?: unknown }).now;
    if (typeof bodyNow === 'string') serverNowRef.current = bodyNow;

    const regs = collectRegJobs(body);
    setServerJobs(regs);
    for (const j of regs) {
      const st = normState(j.state);
      if (j.jobId && st) {
        patchLedger(j.jobId, { state: st, error: j.error ?? null, result: renderResult(j.result) });
      }
    }
    if (!id) return 'go';

    const j = findJob(body, id);
    if (!j) {
      missRef.current += 1;
      const age = jobStartRef.current ? Date.now() - jobStartRef.current : 0;
      // Job di luar jendela 15 menit papan: ketidakhadirannya tidak berarti apa-apa.
      const stale = age > BOARD_WINDOW_MS;
      const vanished = seenRef.current && missRef.current >= 2;
      const neverSeen = !seenRef.current && missRef.current >= 4 && age > 8_000;
      if (stale || vanished || neverSeen) {
        setPhase('unknown');
        patchLedger(id, { state: 'unknown' });
        return stale || vanished ? 'stop' : 'go';
      }
      return 'go';
    }

    seenRef.current = true;
    missRef.current = 0;
    const st = (j.state ?? '').toLowerCase();
    const upd = typeof j.updatedAt === 'string' ? j.updatedAt : null;

    // Setelah "Coba lagi": baris job yang BELUM berubah sejak poll terakhir
    // sebelum retry masih memuat error percobaan sebelumnya. Menampilkannya
    // membuat job yang sedang berjalan terlihat mati — persis kejadian yang
    // hampir membuat owner menekan retry dua kali. Tahan sampai barisnya
    // benar-benar berubah (dibandingkan dengan JAM SERVER, bukan jam HP).
    const marker = retryMarkerRef.current;
    if (marker !== null || retryMaskUntilRef.current > Date.now()) {
      const unchanged = marker !== null ? !upd || upd <= marker : true;
      const expired = retryMaskUntilRef.current <= Date.now();
      if (st === 'failed' && unchanged && !expired) return 'go'; // tetap tampil "antre"
      retryMarkerRef.current = null;
      retryMaskUntilRef.current = 0;
    }

    if (st === 'failed') {
      const err = j.error || 'Job gagal tanpa pesan error.';
      setJobError(err);
      setPhase('failed');
      patchLedger(id, { state: 'failed', error: err });
      return 'stop';
    }
    if (st === 'done') {
      const out = renderResult(j.result);
      setJobResult(out);
      setJobError(null);
      setPhase('done');
      patchLedger(id, { state: 'done', error: null, result: out });
      setActiveJob(null); // sudah ada jawaban — reload berikutnya tidak perlu menunggu
      return 'stop';
    }
    if (st === 'running') {
      setPhase('running');
      patchLedger(id, { state: 'running' });
      return 'go';
    }
    setPhase('queued');
    patchLedger(id, { state: 'queued' });
    return 'go';
  }, [patchLedger, setActiveJob]);

  // ── Rehydrate: job yang dikirim sebelum reload / sebelum HP terkunci ─────
  useEffect(() => {
    const l = readLedger();
    setLedger(l);
    let activeId: string | null = null;
    try { activeId = localStorage.getItem(ACTIVE_KEY); } catch { activeId = null; }
    const e = activeId ? l.find((x) => x.jobId === activeId) ?? null : null;
    if (e && Date.now() - e.createdAt < REHYDRATE_MAX_AGE_MS) {
      jobStartRef.current = e.createdAt;
      setJobId(e.jobId);
      setLastPayload(e.payload);
      setJobError(e.error);
      setJobResult(e.result);
      setStartedAt(e.createdAt);
      setNow(Date.now());
      setTab(e.action === 'register_customer_wholesale' ? 'corporate' : 'retail');
      // Status tampil langsung dari ingatan perangkat; poll di bawah yang
      // memastikan ke server (bisa saja sudah selesai selagi tab tertutup).
      setPhase(e.state === 'done' ? 'done' : e.state === 'failed' ? 'failed' : e.state === 'unknown' ? 'unknown' : 'queued');
    } else {
      if (e) setActiveJob(null); // terlalu tua untuk dibuka lagi — biarkan di riwayat
      void pollOnce(null); // isi "Pendaftaran terakhir" walau tidak ada job aktif
    }
  }, [pollOnce, setActiveJob]);

  // ── Jadwal poll: cepat dulu, mundur pelan, berhenti saat final ──────────
  useEffect(() => {
    if (!jobId || phase === 'sending') return;
    let live = true;
    let n = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const run = async (): Promise<void> => {
      if (!live) return;
      if (Date.now() > deadline) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => { void run(); }, 4000); // tab tersembunyi: jangan bebani papan
        return;
      }
      const verdict = await pollOnce(jobId);
      if (!live || verdict === 'stop') return;
      const d = POLL_DELAYS[n] ?? POLL_STEADY;
      n += 1;
      timer = setTimeout(() => { void run(); }, d);
    };
    void run();
    const onVis = (): void => {
      if (document.hidden || !live) return;
      if (timer) clearTimeout(timer);
      n = 0; // HP baru dibuka lagi — status terbaru sekarang juga
      void run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
    // phase sengaja TIDAK jadi dependency: transisi antre→jalan tidak boleh
    // mereset jadwal backoff. pollNonce yang memaksa jadwal cepat lagi.
  }, [jobId, pollNonce, pollOnce]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const canSubmit = (tab === 'retail' ? retailValid : retailValid && coNameOk && coPicOk && coNpwpOk && coAlamatOk && coAdvisorOk) && !active && retryBusy === null;

  function buildPayload(): ActionPayload {
    const retailParams = { nama: nama.trim(), phone: waE164, alamat: alamat.trim(), branchCode: branch };
    if (tab === 'retail') {
      return { action: 'register_customer_retail', params: retailParams };
    }
    // Worker contract (apps/worker flow executor): company fields FLAT di root
    // params (companyName/picName/npwp/alamat/advisorName + branchCode); hanya
    // customer retail (PIC yang datang) yang nested di params.retail.
    return {
      action: 'register_customer_wholesale',
      params: {
        companyName: coName.trim(),
        picName: coPic.trim(),
        npwp: coNpwp.trim(),
        alamat: coAlamat.trim(),
        advisorName: coAdvisor.trim(),
        branchCode: branch,
        retail: retailParams,
      },
    };
  }

  async function submit(payload?: ActionPayload): Promise<void> {
    const p = payload ?? buildPayload();
    const at = Date.now();
    setLastPayload(p);
    setPhase('sending');
    setJobId(null);
    setJobError(null);
    setJobResult(null);
    seenRef.current = false;
    missRef.current = 0;
    retryMarkerRef.current = null;
    retryMaskUntilRef.current = 0;
    jobStartRef.current = at;
    setStartedAt(at);
    setNow(at);
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
        const msg = typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `Gagal mengirim job (HTTP ${res.status}).`;
        setJobError(msg);
        setPhase('failed');
        // Belum masuk antrean → aman dicoba lagi dari payload, tanpa jobId.
        mutateLedger((l) => [{ jobId: null, action: p.action, label: labelFor(p), createdAt: at, state: 'failed', error: msg, result: null, payload: p }, ...l]);
        return;
      }
      mutateLedger((l) => [{ jobId: id, action: p.action, label: labelFor(p), createdAt: at, state: 'queued', error: null, result: null, payload: p }, ...l.filter((e) => e.jobId !== id)]);
      setActiveJob(id);
      setJobId(id);
      setPhase('queued');
    } catch {
      setJobError('Tidak bisa terhubung ke server — periksa koneksi lalu coba lagi.');
      setPhase('failed');
      mutateLedger((l) => [{ jobId: null, action: p.action, label: labelFor(p), createdAt: at, state: 'failed', error: 'Tidak bisa terhubung ke server.', result: null, payload: p }, ...l]);
    }
  }

  /**
   * Coba lagi. Job yang SUDAH masuk antrean dikirim ulang lewat {retryJobId}:
   * satu baris flow_jobs yang sama dipakai lagi (checkpoint wholesale ikut
   * terbawa), bukan job baru. Job baru berarti perusahaan/customer bisa dibuat
   * dua kali — /api/flow/action tidak punya dedupe untuk aksi tanpa spkId.
   */
  async function doRetry(id: string | null, payload: ActionPayload | null): Promise<void> {
    if (!id) {
      if (payload) void submit(payload);
      return;
    }
    const at = Date.now();
    setRetryBusy(id);
    setJobId(id);
    setPhase('queued');
    setJobError(null);
    setJobResult(null);
    if (payload) setLastPayload(payload);
    seenRef.current = false;
    missRef.current = 0;
    jobStartRef.current = at;
    setStartedAt(at);
    setNow(at);
    retryMarkerRef.current = serverNowRef.current;
    retryMaskUntilRef.current = at + RETRY_MASK_MS;
    patchLedger(id, { state: 'queued', error: null });
    setActiveJob(id);
    try {
      const res = await fetch('/api/flow/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retryJobId: id }),
      });
      if (!res.ok) {
        // 404 = job tidak lagi 'failed' (sudah dicoba ulang di tempat lain).
        // Jangan buat job kedua — biarkan poll menampilkan keadaan sebenarnya.
        retryMarkerRef.current = null;
        retryMaskUntilRef.current = 0;
      }
    } catch {
      retryMarkerRef.current = null;
      retryMaskUntilRef.current = 0;
      setJobError('Tidak bisa terhubung ke server — periksa koneksi lalu coba lagi.');
      setPhase('failed');
    } finally {
      setRetryBusy(null);
      setPollNonce((n) => n + 1);
    }
  }

  function resetForNext(): void {
    setPhase('idle');
    setJobId(null);
    setLastPayload(null);
    setJobError(null);
    setJobResult(null);
    setActiveJob(null);
    seenRef.current = false;
    missRef.current = 0;
    setNama('');
    setWa('');
    setAlamat('');
    setCoName('');
    setCoPic('');
    setCoNpwp('');
    setCoAlamat('');
    setCoAdvisor('');
  }

  // Riwayat = ingatan perangkat ini + job pendaftaran milik perangkat lain,
  // status selalu diambil dari server bila job-nya masih ada di papan.
  const recent = useMemo<RegEntry[]>(() => {
    const srv = new Map<string, FlowJobView>();
    for (const j of serverJobs) if (j.jobId) srv.set(j.jobId, j);
    const merged: RegEntry[] = ledger.map((e) => {
      const s = e.jobId ? srv.get(e.jobId) : undefined;
      if (!s) return e;
      return { ...e, state: normState(s.state) ?? e.state, error: s.error ?? null, result: renderResult(s.result) ?? e.result };
    });
    for (const [id, s] of srv) {
      if (merged.some((e) => e.jobId === id)) continue;
      merged.push({
        jobId: id,
        action: s.action ?? '',
        label: 'Dikirim dari perangkat lain',
        createdAt: Date.parse(s.createdAt ?? '') || 0,
        state: normState(s.state) ?? 'queued',
        error: s.error ?? null,
        result: renderResult(s.result),
        payload: null,
      });
    }
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged.slice(0, RECENT_SHOWN);
  }, [ledger, serverJobs]);

  // Nomor yang SAMA baru saja didaftarkan dari perangkat ini → hampir pasti
  // dobel (pencarian Turboly prefix-match, dua record sulit digabung lagi).
  const dupWarn = useMemo<RegEntry | null>(() => {
    if (!waE164 || active) return null;
    return recent.find((e) => e.state !== 'failed' && phoneOf(e.payload) === waE164 && now - e.createdAt < 30 * 60_000) ?? null;
  }, [recent, waE164, active, now]);

  const elapsed = fmtElapsed(now - startedAt);
  const slow = active && startedAt > 0 && now - startedAt > 2 * 60_000;
  // Job milik perangkat lain tidak punya payload lokal — jenisnya diambil dari riwayat.
  const currentEntry = jobId ? recent.find((e) => e.jobId === jobId) ?? null : null;
  const actionLabel = actionShort(lastPayload?.action ?? currentEntry?.action ?? (tab === 'retail' ? 'register_customer_retail' : 'register_customer_wholesale'));

  return (
    <>
      <style>{`
        .cst-live { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; font-size: 14px;
                    background: #EAF0FF; color: #1E2E91; border-left: 4px solid var(--nawilis-2); }
        .cst-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--nawilis-2); flex: none;
                   animation: cst-pulse 1.1s ease-in-out infinite; }
        .cst-bar { height: 3px; border-radius: 3px; margin-top: 8px; background: #EAF0FF; overflow: hidden; }
        .cst-bar i { display: block; height: 100%; width: 38%; background: var(--nawilis-2); animation: cst-slide 1.4s ease-in-out infinite; }
        @keyframes cst-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .3; transform: scale(.65); } }
        @keyframes cst-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
        @media (prefers-reduced-motion: reduce) { .cst-dot, .cst-bar i { animation: none; } }
        .cst-dead { padding: 10px 12px; border-radius: 8px; font-size: 14px; background: #fdecea; color: var(--block); border-left: 4px solid var(--block); }
        .cst-done { padding: 10px 12px; border-radius: 8px; font-size: 14px; background: #e6f4ea; color: var(--ok); border-left: 4px solid var(--ok); }
        .cst-hold { padding: 10px 12px; border-radius: 8px; font-size: 14px; background: #fef3c7; color: #b45309; border-left: 4px solid #d97706; }
        .cst-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); }
        .cst-row:first-of-type { border-top: none; }
        .cst-row .m { flex: 1; min-width: 0; }
        .cst-row .t { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
        .cst-row .s { font-size: 10.5px; color: var(--muted); margin-top: 2px; line-height: 1.35; overflow-wrap: anywhere; }
        .cst-mini { font-size: 11px; font-weight: 700; padding: 5px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; cursor: pointer; flex: none; }
        .cst-mini:disabled { opacity: .5; }
      `}</style>

      <div className="topbar">
        <BrandMark page="CUSTOMER BARU" />
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
          <div className="card" aria-live="polite">
            <div className="label">Status pendaftaran — {actionLabel}</div>
            {phase === 'sending' && (
              <div className="cst-live"><span className="cst-dot" />Mengirim ke antrean robot…</div>
            )}
            {phase === 'queued' && (
              <>
                <div className="cst-live"><span className="cst-dot" />Antre — menunggu robot mengambil job ({elapsed})</div>
                <div className="cst-bar"><i /></div>
              </>
            )}
            {phase === 'running' && (
              <>
                <div className="cst-live"><span className="cst-dot" />Robot sedang mendaftarkan di Turboly… ({elapsed})</div>
                <div className="cst-bar"><i /></div>
              </>
            )}
            {phase === 'unknown' && (
              <>
                <div className="cst-hold">
                  ⚠ Hasil belum pasti. Job {jobId ? `(ID ${jobId}) ` : ''}tidak ada di papan antrean — papan hanya menyimpan 15 menit terakhir, jadi ini bisa berarti SUDAH SELESAI.
                  <div style={{ marginTop: 6, fontWeight: 700 }}>Periksa Customers di Turboly lebih dulu; jangan kirim ulang (risiko dobel daftar).</div>
                </div>
                {/* Tanpa tombol ini kartu "tidak pasti" mengunci halaman: satu-satunya
                    jalan keluar yang benar adalah operator memeriksa Turboly sendiri. */}
                <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={resetForNext}>
                  Sudah saya periksa di Turboly — tutup status ini
                </button>
              </>
            )}
            {phase === 'done' && (
              <>
                <div className="cst-done">✓ Selesai — customer {actionLabel.toLowerCase()} berhasil didaftarkan robot.{jobResult ? ` (${jobResult})` : ''}</div>
                <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={resetForNext}>+ Daftarkan customer lain</button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <div className="cst-dead">✗ Gagal, tidak ada yang berjalan sekarang: {jobError ?? 'tanpa pesan error'}</div>
                {jobError?.includes('login') && (
                  <div className="warn-note">Buka <a href="/login">halaman login</a> lalu kembali ke sini.</div>
                )}
                <button
                  type="button"
                  className="btn ghost"
                  style={{ width: '100%', marginTop: 10 }}
                  disabled={retryBusy !== null || (!jobId && !lastPayload)}
                  onClick={() => { void doRetry(jobId, lastPayload); }}
                >
                  {retryBusy !== null ? 'Mengirim ulang…' : '↻ Coba lagi'}
                </button>
                {jobId && <div className="ok-sm" style={{ color: '#55627a' }}>Percobaan ulang memakai job yang sama — tidak membuat customer kedua.</div>}
              </>
            )}
            {(phase === 'queued' || phase === 'running') && (
              <div className="ok-sm" style={{ color: '#55627a' }}>Halaman boleh ditutup — status pendaftaran ini tersimpan di perangkat dan muncul lagi saat dibuka.</div>
            )}
            {slow && (
              <div className="warn-note">⚠ Lebih lama dari biasanya ({elapsed}). Antrean robot berjalan serial — job lain mungkin sedang diproses. Halaman ini terus memantau otomatis.</div>
            )}
            {authLost && (
              <div className="warn-note">⚠ Status tidak bisa dipantau: sesi login habis. Job tetap berjalan di server — <a href="/login">login ulang</a> untuk melihat hasilnya.</div>
            )}
            {jobId && phase !== 'done' && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>Job: {jobId}</div>}
          </div>
        )}

        {dupWarn && (
          <div className="warn-note" style={{ marginBottom: 14 }}>
            ⚠ Nomor {waE164} baru saja didaftarkan dari perangkat ini ({fmtAgo(dupWarn.createdAt, now)} — {dupWarn.label}). Periksa Turboly dulu; mendaftar dua kali membuat customer dobel.
          </div>
        )}

        <button className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
          {active
            ? 'Sedang diproses…'
            : tab === 'retail'
              ? 'Daftarkan Customer Retail'
              : 'Daftarkan Perusahaan + Customer'}
        </button>

        {/* ── Riwayat pendaftaran ── */}
        {recent.length > 0 && (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="label">Pendaftaran terakhir</div>
            {recent.map((e) => {
              const live = e.state === 'queued' || e.state === 'running';
              const badge = e.state === 'done' ? 'green' : e.state === 'failed' ? 'red' : e.state === 'unknown' ? 'yellow' : 'blue';
              const stateText = e.state === 'done' ? 'BERHASIL'
                : e.state === 'failed' ? 'GAGAL'
                  : e.state === 'unknown' ? 'TIDAK PASTI'
                    : e.state === 'running' ? 'BERJALAN' : 'ANTRE';
              const canRetry = e.state === 'failed' && (e.jobId !== null || e.payload !== null);
              const isCurrent = e.jobId !== null && e.jobId === jobId;
              return (
                <div className="cst-row" key={e.jobId ?? `local-${e.createdAt}`}>
                  <span className={`badge ${badge}`} style={{ marginTop: 2 }}>
                    {live && <span className="cst-dot" style={{ display: 'inline-block', marginRight: 5, verticalAlign: 'middle' }} />}
                    {stateText}
                  </span>
                  <div className="m">
                    <div className="t">{e.label}</div>
                    <div className="s">
                      {actionShort(e.action)} · {fmtAgo(e.createdAt, now)}
                      {e.state === 'failed' && e.error ? ` · ${e.error}` : ''}
                      {e.state === 'done' && e.result ? ` · ${e.result}` : ''}
                      {e.state === 'unknown' ? ' · periksa di Turboly sebelum daftar ulang' : ''}
                    </div>
                  </div>
                  {canRetry && (
                    <button
                      type="button"
                      className="cst-mini"
                      disabled={retryBusy !== null || (active && !isCurrent)}
                      onClick={() => { void doRetry(e.jobId, e.payload); }}
                    >
                      {retryBusy === e.jobId ? '…' : '↻ Coba lagi'}
                    </button>
                  )}
                </div>
              );
            })}
            <div className="ok-sm" style={{ color: '#55627a' }}>Riwayat perangkat ini + job pendaftaran yang sedang berjalan di papan (15 menit terakhir).</div>
          </div>
        )}

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
