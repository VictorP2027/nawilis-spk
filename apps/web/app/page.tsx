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
  sku?: string;
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
  const [showSetup, setShowSetup] = useState(false); // reopened via the topbar branch badge
  const [jadwalOn, setJadwalOn] = useState(false);
  const [tglJadwal, setTglJadwal] = useState('');
  const [jamJadwal, setJamJadwal] = useState('');
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [makeKnown, setMakeKnown] = useState(false);
  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
  const [svcOpts, setSvcOpts] = useState<Record<string, { defaultSku: string; options: { sku: string; label: string }[] }>>({});

  useEffect(() => {
    fetch('/api/vehicle-makes').then((r) => r.json()).then((d) => setMakes(d.makes ?? [])).catch(() => {});
    fetch('/api/service-options').then((r) => r.json()).then((d) => setSvcOpts(d.services ?? {})).catch(() => {});
  }, []);
  useEffect(() => {
    const m = merk.trim();
    if (!m) { setModels([]); setMakeKnown(false); return; }
    let live = true;
    fetch(`/api/vehicle-models?make=${encodeURIComponent(m)}`).then((r) => r.json())
      .then((d) => { if (live) { setModels(d.models ?? []); setMakeKnown(!!d.known); } }).catch(() => {});
    return () => { live = false; };
  }, [merk]);
  useEffect(() => {
    if (!branch) { setAdvisors([]); return; }
    let live = true;
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`).then((r) => r.json())
      .then((d) => { if (live) setAdvisors(d.advisors ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [branch]);
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
      jobLines: Object.values(jobs).map((j) => ({ serviceCode: j.code, ordered: true, qty: j.qty, quotedPrice: j.price ? Number(j.price) : null, chosenSku: j.sku || svcOpts[j.code]?.defaultSku || null })),
      scheduledAt: jadwalOn && tglJadwal && jamJadwal && Date.parse(`${tglJadwal}T${jamJadwal}`) > Date.now() ? new Date(`${tglJadwal}T${jamJadwal}`).toISOString() : undefined,
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
        setResult({ ok: true, text: `✓ Tersimpan & dikirim ke Turboly.${notes ? ` (Catatan: ${notes})` : ''}`, token: body.correlationToken });
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

  // Branch routes the store; WA is REQUIRED — it is the customer identity key.
  const waDigits = wa.replace(/\D/g, '');
  const waOk = waDigits.length >= 9;
  const canSubmit = !!branch && waOk && !submitting;
  const plateNorm = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const plateBad = plate.trim() !== '' && !/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(plateNorm);
  const kmValQ = /\d/.test(km) ? Number(km.replace(/[.\s]/g, '')) : NaN;
  const kmBelowPrev = hist?.lastKm != null && !Number.isNaN(kmValQ) && kmValQ < hist.lastKm;
  const makeUnknown = merk.trim() !== '' && makes.length > 0 && !makes.some((m) => m.toUpperCase() === merk.trim().toUpperCase());
  const modelUnknown = tipe.trim() !== '' && makeKnown && models.length > 0 && !models.some((m) => m.toUpperCase() === tipe.trim().toUpperCase());
  const advisorUnknown = advisor.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === advisor.trim().toUpperCase());

  return (
    <>
      <div className="topbar">
        <span className="brand">NAWILIS · SPK</span>
        <button type="button" className="branch" style={{ border: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => setShowSetup((v) => !v)} title="Ganti cabang / petugas">
          {BRANCHES.find((b) => b.code === branch)?.name ?? 'Pilih cabang'} ▾
        </button>
      </div>
      <div className="wrap">
        {(!branch || showSetup) && (
          <div className="card">
            <div className="label">Cabang</div>
            <select value={branch} onChange={(e) => { setBranch(e.target.value); if (e.target.value) setShowSetup(false); }}>
              <option value="">— pilih cabang —</option>
              {BRANCHES.map((b) => (
                <option key={b.code} value={b.code}>{b.name}</option>
              ))}
            </select>
            <div className="label" style={{ marginTop: 12 }}>Nama petugas (opsional)</div>
            <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="mis. Rina — diingat di perangkat ini" />
          </div>
        )}

        <div className="card">
          <div className="label">No. Polisi</div>
          <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="B 1234 SZA" autoCapitalize="characters" style={plateBad ? { borderColor: '#d97706' } : undefined} />
          {plateBad && <div className="warn-note">⚠ Format tidak wajar (contoh: B 1234 XYZ) — boleh lanjut.</div>}
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
              <input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" placeholder="45.230" style={kmBelowPrev ? { borderColor: '#d97706' } : undefined} />
              {kmBelowPrev && <div className="warn-note">⚠ Lebih kecil dari kunjungan sebelumnya ({Number(hist!.lastKm).toLocaleString('id-ID')}) — boleh lanjut.</div>}
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
                <input list="make-list-q" value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="Toyota" style={makeUnknown ? { borderColor: '#d97706' } : undefined} />
                <datalist id="make-list-q">{makes.map((m) => <option key={m} value={m} />)}</datalist>
                {makeUnknown && <div className="warn-note">⚠ Merk tidak ada di katalog Turboly — boleh lanjut.</div>}
              </div>
              <div>
                <div className="label">Tipe</div>
                <input list="model-list-q" value={tipe} onChange={(e) => setTipe(e.target.value)} placeholder="Avanza" style={modelUnknown ? { borderColor: '#d97706' } : undefined} />
                <datalist id="model-list-q">{models.map((m) => <option key={m} value={m} />)}</datalist>
                {modelUnknown && <div className="warn-note">⚠ Tipe tidak ada di daftar {merk.trim().toUpperCase()} — dipetakan ke model paling mirip saat kirim.</div>}
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
                  {on && svcOpts[s.code]?.options?.length ? (
                    <select
                      value={jobs[s.code]!.sku || svcOpts[s.code]!.defaultSku}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, sku: e.target.value } }))}
                      style={{ marginTop: 6, fontSize: 13, padding: '8px 10px' }}
                    >
                      {svcOpts[s.code]!.options.map((o) => <option key={o.sku} value={o.sku}>{o.label}</option>)}
                    </select>
                  ) : null}
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
            <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="No. WA — WAJIB (08…)" />
            <input value={alamat} onChange={(e) => setAlamat(e.target.value)} placeholder="Alamat (opsional)" />
          </div>
          {!waOk && <div className="warn-note">⚠ No. WA <b>wajib</b> — identitas pelanggan (min. 9 digit, cth 08123456789).</div>}
          <div className="label" style={{ marginTop: 12 }}>Yang menerima (Service Advisor)</div>
          <input list="advisor-list-q" value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder={advisors.length ? 'Pilih dari daftar / ketik' : 'Nama advisor'} style={advisorUnknown ? { borderColor: '#d97706' } : undefined} />
          <datalist id="advisor-list-q">{advisors.map((a) => <option key={a.code} value={a.name} />)}</datalist>
          {advisorUnknown && <div className="warn-note">⚠ Tidak ada di daftar advisor cabang — order memakai advisor terdaftar sebagai fallback.</div>}
          <div className="label" style={{ marginTop: 12 }}>Keluhan</div>
          <textarea value={keluhan} onChange={(e) => setKeluhan(e.target.value)} rows={2} placeholder="Keluhan customer" />
        </div>

        {!jadwalOn ? (
          <button type="button" className="btn ghost" style={{ width: '100%', marginBottom: 14 }} onClick={() => setJadwalOn(true)}>🕐 Jadwalkan servis (opsional)</button>
        ) : (
          <div className="card">
            <div className="label">Jadwal servis — kosongkan / tutup untuk langsung (walk-in)</div>
            <div className="row">
              <input type="date" value={tglJadwal} onChange={(e) => setTglJadwal(e.target.value)} />
              <input type="time" value={jamJadwal} onChange={(e) => setJamJadwal(e.target.value)} />
            </div>
            {tglJadwal && jamJadwal && Date.parse(`${tglJadwal}T${jamJadwal}`) > Date.now() && (
              <div className="ok-note">✓ Akan dijadwalkan di Turboly: {tglJadwal} {jamJadwal}</div>
            )}
            <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => { setJadwalOn(false); setTglJadwal(''); setJamJadwal(''); }}>✕ Batal jadwal (langsung)</button>
          </div>
        )}

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
