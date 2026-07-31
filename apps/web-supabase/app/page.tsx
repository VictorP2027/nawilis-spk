'use client';

import { useEffect, useMemo, useState } from 'react';
import { SERVICES, BRANCHES } from '../lib/refdata.client';
import { submitOrQueue, flush, pending } from '../lib/outbox';

interface VehicleHist {
  plateFull: string;
  merk: string | null;
  tipe: string | null;
  tahun: number | null;
  warna: string | null;
  lastKm: number | null;
  lastSeenAt: string | null;
  lastBranch: string | null;
  visitCount: number;
}

interface JobSel {
  code: string;
  label: string;
  qty: number;
  price: string;
}

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function Intake() {
  const [branch, setBranch] = useState<string>('');
  const [operator, setOperator] = useState<string>('');
  const [plate, setPlate] = useState('');
  const [hist, setHist] = useState<VehicleHist | null>(null);
  const [km, setKm] = useState('');
  const [merk, setMerk] = useState('');
  const [tipe, setTipe] = useState('');
  const [tahun, setTahun] = useState('');
  const [warna, setWarna] = useState('');
  const [nama, setNama] = useState('');
  const [wa, setWa] = useState('');
  const [alamat, setAlamat] = useState('');
  const [advisor, setAdvisor] = useState('');
  const [keluhan, setKeluhan] = useState('');
  const [jobs, setJobs] = useState<Record<string, JobSel>>({});
  const [outbox, setOutbox] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; text: string; token?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Restore branch/operator; start the outbox flusher.
  useEffect(() => {
    setBranch(localStorage.getItem('branch') ?? '');
    setOperator(localStorage.getItem('operator') ?? '');
    setOutbox(pending());
    const t = setInterval(async () => {
      const sent = await flush();
      if (sent > 0) setOutbox(pending());
    }, 20_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (branch) localStorage.setItem('branch', branch);
  }, [branch]);
  useEffect(() => {
    if (operator) localStorage.setItem('operator', operator);
  }, [operator]);

  // Debounced plate → history lookup (returning-customer fast path).
  useEffect(() => {
    const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key.length < 4) {
      setHist(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/vehicle?plate=${encodeURIComponent(key)}`);
        const { vehicle } = await res.json();
        if (vehicle) {
          setHist(vehicle);
          setMerk((m) => m || vehicle.merk || '');
          setTipe((v) => v || vehicle.tipe || '');
          setTahun((y) => y || (vehicle.tahun ? String(vehicle.tahun) : ''));
          setWarna((w) => w || vehicle.warna || '');
        } else setHist(null);
      } catch {
        /* offline — ignore */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [plate]);

  const orderedTotal = useMemo(
    () => Object.values(jobs).reduce((s, j) => s + (Number(j.price) || 0) * j.qty, 0),
    [jobs],
  );

  function toggleJob(code: string, label: string) {
    setJobs((prev) => {
      const next = { ...prev };
      if (next[code]) delete next[code];
      else next[code] = { code, label, qty: 1, price: '' };
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    setResult(null);
    const uploadId = uuid();
    const payload = {
      uploadId,
      docType: 'SPK_NAWILIS',
      branchCode: branch,
      captureMode: 'typed',
      operatorUserId: operator || 'unattributed',
      operatorPinVerified: !!operator,
      deviceBindingVerified: true,
      capturedAt: new Date().toISOString(),
      customer: { nama, wa: wa || null, alamat: alamat || null },
      vehicle: {
        noPolisi: plate,
        merk: merk || null,
        tipe: tipe || null,
        tahun: tahun ? Number(tahun) : null,
        warna: warna || null,
        km,
      },
      complaint: keluhan || null,
      jobLines: Object.values(jobs).map((j) => ({ serviceCode: j.code, ordered: true, qty: j.qty, quotedPrice: j.price ? Number(j.price) : null })),
      serviceAdvisorName: advisor || null,
      salespersonName: advisor || null,
      signatures: { menyerahkanPresent: false, menerimaPresent: !!advisor, menerimaNamaJelas: advisor || null },
    };

    const res = await submitOrQueue(uploadId, payload);
    if (!res) {
      setOutbox(pending());
      setResult({ ok: true, text: 'Tersimpan offline — akan dikirim otomatis saat online.' });
      resetForm();
      setSubmitting(false);
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const notes = (body.findings ?? []).map((f: { message: string }) => f.message).join('; ');
      if (body.needsReview) {
        // Still SAVED in Mongo — just needs a fix/verify before it can proceed.
        setResult({ ok: false, text: `Tersimpan, perlu diperbaiki: ${notes}`, token: body.correlationToken });
      } else {
        setResult({ ok: true, text: `✓ Tersimpan ke MongoDB. Menunggu ditugaskan ke mekanik.${notes ? ` (Catatan: ${notes})` : ''}`, token: body.correlationToken });
        resetForm();
      }
    } else {
      setResult({ ok: false, text: body.error ?? 'Gagal menyimpan.' });
    }
    setSubmitting(false);
  }

  function resetForm() {
    setPlate('');
    setHist(null);
    setKm('');
    setMerk('');
    setTipe('');
    setTahun('');
    setWarna('');
    setNama('');
    setWa('');
    setAlamat('');
    setKeluhan('');
    setJobs({});
  }

  // Advisor is a push-time field, not required to capture into MongoDB.
  const canSubmit = branch && plate && km && Object.keys(jobs).length > 0 && nama && !submitting;

  return (
    <>
      <div className="topbar">
        <span className="brand">NAWILIS · SPK</span>
        <span className="branch">{BRANCHES.find((b) => b.code === branch)?.name ?? 'Pilih cabang'}</span>
      </div>
      <div className="wrap">
        {(!branch || !operator) && (
          <div className="card">
            <div className="label">Cabang</div>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">— pilih cabang —</option>
              {BRANCHES.map((b) => (
                <option key={b.code} value={b.code}>{b.name}</option>
              ))}
            </select>
            <div className="label" style={{ marginTop: 12 }}>Operator (PIN / nama)</div>
            <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="mis. Rina" />
          </div>
        )}

        <div className="card">
          <div className="label">No. Polisi</div>
          <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="B 1234 SZA" autoCapitalize="characters" />
          {hist && (
            <div className="hist" style={{ marginTop: 10 }}>
              {hist.merk} {hist.tipe} {hist.tahun ?? ''} {hist.warna ?? ''} · terakhir {hist.lastKm?.toLocaleString('id-ID')} km · {hist.visitCount}× kunjungan
            </div>
          )}
        </div>

        <div className="card">
          <div className="row">
            <div>
              <div className="label">KM</div>
              <input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" placeholder="45.230" />
            </div>
            <div>
              <div className="label">Tahun / Warna</div>
              <div className="row">
                <input value={tahun} onChange={(e) => setTahun(e.target.value)} inputMode="numeric" placeholder="2019" />
                <input value={warna} onChange={(e) => setWarna(e.target.value)} placeholder="Silver" />
              </div>
            </div>
          </div>
          {!hist && (
            <div className="row" style={{ marginTop: 10 }}>
              <div>
                <div className="label">Merk</div>
                <input value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="Toyota" />
              </div>
              <div>
                <div className="label">Tipe</div>
                <input value={tipe} onChange={(e) => setTipe(e.target.value)} placeholder="Avanza" />
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="label">Pekerjaan</div>
          <div className="tiles">
            {SERVICES.map((s) => {
              const on = !!jobs[s.code];
              return (
                <button key={s.code} type="button" className={`tile ${on ? 'on' : ''}`} onClick={() => toggleJob(s.code, s.label)}>
                  {s.label}
                  {on && (
                    <input
                      className="price"
                      value={jobs[s.code]!.price}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, price: e.target.value } }))}
                      inputMode="numeric"
                      placeholder="harga (Rp)"
                    />
                  )}
                </button>
              );
            })}
          </div>
          {orderedTotal > 0 && <div style={{ marginTop: 10, fontWeight: 700 }}>Estimasi: Rp {orderedTotal.toLocaleString('id-ID')}</div>}
        </div>

        <div className="card">
          <div className="label">Customer</div>
          <input value={nama} onChange={(e) => setNama(e.target.value)} placeholder="Nama" />
          <div className="row" style={{ marginTop: 10 }}>
            <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="No. WA (08…)" />
            <input value={alamat} onChange={(e) => setAlamat(e.target.value)} placeholder="Alamat (opsional)" />
          </div>
          <div className="label" style={{ marginTop: 12 }}>Yang menerima (Service Advisor)</div>
          <input value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder="Nama advisor" />
          <div className="label" style={{ marginTop: 12 }}>Keluhan</div>
          <textarea value={keluhan} onChange={(e) => setKeluhan(e.target.value)} rows={2} placeholder="Keluhan customer" />
        </div>

        {result && (
          <div className="card">
            <div className={`finding ${result.ok ? 'WARN' : 'BLOCK'}`} style={result.ok ? { background: '#e6f4ea', color: '#157a3c' } : undefined}>
              {result.text}
            </div>
            {result.token && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>Token: {result.token}</div>}
          </div>
        )}

        <button className="btn primary" disabled={!canSubmit} onClick={submit}>
          {submitting ? 'Menyimpan…' : 'Simpan SPK & Cetak Tiket'}
        </button>

        <div className="sync" style={{ marginTop: 12, textAlign: 'center', color: 'var(--muted)' }}>
          {outbox > 0 ? `⏳ ${outbox} SPK belum terkirim (akan dikirim otomatis)` : '✓ Semua tersinkron'}
          {' · '}
          <a href="/sheet">Form SPK (lembar)</a>
          {' · '}
          <a href="/admin">Dashboard</a>
        </div>
      </div>
    </>
  );
}
