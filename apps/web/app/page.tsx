'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { SignaturePad, type SigHandle } from './components/SignaturePad';
import { SERVICES, BRANCHES, DAMAGE_ZONES } from '../lib/refdata.client';
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
  // Registered owner of the typed plate (from Turboly) — one plate = one owner.
  const [plateOwner, setPlateOwner] = useState<{ nama: string; wa: string | null } | null>(null);
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
  const [dmg, setDmg] = useState<Set<string>>(new Set());
  const sigCust = useRef<SigHandle>(null);
  const sigAdv = useRef<SigHandle>(null);
  const [custSigned, setCustSigned] = useState(false);
  const toggleDmg = (z: string) => setDmg((prev) => { const n = new Set(prev); n.has(z) ? n.delete(z) : n.add(z); return n; });
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
      setPlateOwner(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/vehicle?plate=${encodeURIComponent(key)}`);
        const { vehicle, customer } = await res.json();
        if (vehicle) {
          setHist(vehicle);
          setMerk((m) => m || vehicle.merk || '');
          setTipe((v) => v || vehicle.tipe || '');
          setTahun((y) => y || (vehicle.tahun ? String(vehicle.tahun) : ''));
          setWarna((w) => w || vehicle.warna || '');
        } else setHist(null);
        setPlateOwner(customer ?? null);
        if (customer) {
          setNama((x) => x || customer.nama || '');
          setWa((x) => x || customer.wa || '');
          setAlamat((x) => x || customer.alamat || '');
        }
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
      complaint: [keluhan, [...dmg].length ? `Kerusakan bodi: ${[...dmg].map((z) => DAMAGE_ZONES.find((d) => d.code === z)?.label ?? z).join(', ')}` : ''].filter(Boolean).join(' | ') || null,
      jobLines: Object.values(jobs).map((j) => ({ serviceCode: j.code, ordered: true, qty: j.qty, quotedPrice: j.price ? Number(j.price) : null, chosenSku: j.sku || svcOpts[j.code]?.defaultSku || null })),
      scheduledAt: jadwalOn && tglJadwal && jamJadwal && Date.parse(`${tglJadwal}T${jamJadwal}`) > Date.now() ? new Date(`${tglJadwal}T${jamJadwal}`).toISOString() : undefined,
      serviceAdvisorName: advisor || null,
      salespersonName: advisor || null,
      signatures: {
        menyerahkanPresent: !!sigCust.current?.get(),
        menyerahkanNamaJelas: nama || null,
        menerimaPresent: !!advisor || !!sigAdv.current?.get(),
        menerimaNamaJelas: advisor || null,
        menyerahkanImage: sigCust.current?.get() ?? null,
        menerimaImage: sigAdv.current?.get() ?? null,
      },
    };

    const res = await submitOrQueue(uploadId, payload);
    if (typeof res === 'string') {
      setOutbox(pending());
      if (res === 'lost') {
        setResult({ ok: false, text: '✗ GAGAL menyimpan: penyimpanan perangkat penuh & tidak ada koneksi. Data TIDAK tersimpan — hubungkan internet lalu coba lagi.' });
      } else {
        setResult({ ok: true, text: 'Tersimpan offline — akan dikirim otomatis saat online.' });
        resetForm();
      }
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
    setDmg(new Set());
    sigCust.current?.clear();
    sigAdv.current?.clear();
    // Advisor must be a deliberate choice per SPK — never carried over from the
    // previous customer (wrong person would get the sales credit).
    setAdvisor('');
  }

  // Branch routes the store; WA is REQUIRED — it is the customer identity key.
  const waDigits = wa.replace(/\D/g, '');
  // ENFORCED Indonesian format: mobile starts with 8 after stripping +62/62/0,
  // 9-12 national digits. Stored as E.164 (+62…) server-side.
  const waNat = waDigits.replace(/^62/, '').replace(/^0/, '');
  const waOk = /^8\d{8,11}$/.test(waNat);
  const waE164Preview = waOk ? `+62${waNat}` : null;
const canonK = (s: string) => s.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
  // Plat boleh terdaftar di lebih dari satu pemilik (mobil pindah tangan):
  // sistem otomatis mendaftarkan kendaraan ke pemilik baru saat push. Warning
  // ini hanya mengingatkan bila WA berbeda dari pemilik terdaftar terakhir.
  const ownerMismatch = !!plateOwner?.wa && canonK(wa).length >= 8 && canonK(plateOwner.wa) !== canonK(wa);
  // Advisor wajib: Turboly menolak Service Order tanpa Service Advisor, dan
  // kita tidak pernah memilih advisor otomatis (kredit penjualan salah orang).
  const advisorOk = advisor.trim() !== '';
  // Alamat wajib: linked to the person (prefilled from Turboly) and required
  // so every registration carries a reachable address.
  const alamatOk = alamat.trim() !== '';
  // Required set mirrors the reference intake app: plate, nama, WA, alamat,
  // merk, warna, KM, tahun (Tipe stays optional).
  const plateOk = plate.trim() !== '';
  const namaOk = nama.trim() !== '';
  const merkOk = merk.trim() !== '';
  const warnaOk = warna.trim() !== '';
  const kmOk = km.trim() !== '';
  const tahunOk = tahun.trim() !== '';
  const canSubmit = !!branch && waOk && advisorOk && alamatOk && plateOk && namaOk && merkOk && warnaOk && kmOk && tahunOk && custSigned && !submitting;
  const plateNorm = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const plateBad = plate.trim() !== '' && !/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(plateNorm);
  const kmValQ = /\d/.test(km) ? Number(km.replace(/[.\s]/g, '')) : NaN;
  const kmBelowPrev = hist?.lastKm != null && !Number.isNaN(kmValQ) && kmValQ < hist.lastKm;
  // PHONE-FIRST: typing the WA auto-populates person + car(s); chips switch cars.
  const [custVehicles, setCustVehicles] = useState<Array<{ plate: string; merk: string | null; tipe: string | null; tahun: number | null; warna: string | null }>>([]);
  const [custHint, setCustHint] = useState<string | null>(null);
  const [regName, setRegName] = useState<string | null>(null);
  useEffect(() => {
    if (waDigits.length < 9) { setCustVehicles([]); setCustHint(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/customer?phone=${encodeURIComponent(wa)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!live) return;
          if (d?.customer) {
            setRegName(d.customer.nama || null);
            if (d.customer.nama) setNama(d.customer.nama); // original name linked to the phone wins
            setAlamat((x) => x || d.customer.alamat || '');
            const vs = d.vehicles ?? [];
            setCustVehicles(vs);
            setCustHint(`${d.customer.nama} — ${vs.length} kendaraan`);
            const v = vs[0];
            if (v && !plate && !merk) { setPlate(v.plate); setMerk(v.merk ?? ''); setTipe(v.tipe ?? ''); setTahun(v.tahun ? String(v.tahun) : ''); setWarna(v.warna ?? ''); }
          } else { setCustVehicles([]); setCustHint(null); setRegName(null); }
        })
        .catch(() => { if (live) { setCustVehicles([]); setCustHint(null); } });
    }, 500);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wa]);
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
          <div className="label">Nomor WhatsApp — identitas pelanggan (ketik dulu)</div>
          <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="08…" style={!waOk ? { borderColor: '#dc2626' } : undefined} />
          {!waOk && <div className="req-note">⚠ wajib — format Indonesia 08… / +62 8…, contoh 08123456789</div>}
          {waOk && <div className="ok-note">✓ {waE164Preview}</div>}
          {custHint && (
            <div className="ok-note">↩ {custHint}{custVehicles.length > 1 ? ' — pilih mobil:' : ''}
              {custVehicles.length > 1 && (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {custVehicles.map((v) => (
                    <button key={v.plate} type="button" className="btn ghost" style={{ fontSize: 13, padding: '8px 10px' }}
                      onClick={() => { setPlate(v.plate); setMerk(v.merk ?? ''); setTipe(v.tipe ?? ''); setTahun(v.tahun ? String(v.tahun) : ''); setWarna(v.warna ?? ''); }}>
                      {v.plate}{v.merk ? ` · ${v.merk}` : ''}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="label">No. Polisi</div>
          <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="B 1234 SZA — WAJIB" autoCapitalize="characters" style={!plateOk ? { borderColor: '#dc2626' } : plateBad ? { borderColor: '#d97706' } : undefined} />
          {!plateOk && <div className="req-note">⚠ wajib diisi</div>}
          {plateBad && <div className="warn-note">⚠ Format tidak wajar (contoh: B 1234 XYZ) — boleh lanjut.</div>}
          {ownerMismatch && plateOwner && (
            <div className="warn-note">⚠ Plat ini milik <b>{plateOwner.nama}</b> ({plateOwner.wa}) — WA berbeda. Order Turboly <b>tetap atas nama {plateOwner.nama}</b>; orang di form ini dicatat sebagai pembawa kendaraan di Notes.</div>
          )}
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
              <input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" placeholder="45.230 — WAJIB" style={!kmOk ? { borderColor: '#dc2626' } : kmBelowPrev ? { borderColor: '#d97706' } : undefined} />
              {!kmOk && <div className="req-note">⚠ wajib diisi</div>}
              {kmBelowPrev && <div className="warn-note">⚠ Lebih kecil dari kunjungan sebelumnya ({Number(hist!.lastKm).toLocaleString('id-ID')}) — boleh lanjut.</div>}
            </div>
            <div>
              <div className="label">Tahun / Warna</div>
              <div className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input value={tahun} onChange={(e) => setTahun(e.target.value)} inputMode="numeric" placeholder="2019 — WAJIB" style={!tahunOk ? { borderColor: '#dc2626' } : undefined} />
                  {!tahunOk && <div className="req-note">⚠ wajib diisi</div>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input value={warna} onChange={(e) => setWarna(e.target.value)} placeholder="Silver — WAJIB" style={!warnaOk ? { borderColor: '#dc2626' } : undefined} />
                  {!warnaOk && <div className="req-note">⚠ wajib diisi</div>}
                </div>
              </div>
            </div>
          </div>
          {!hist && (
            <div className="row" style={{ marginTop: 10 }}>
              <div>
                <div className="label">Merk</div>
                <input list="make-list-q" value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="Toyota — WAJIB" style={!merkOk ? { borderColor: '#dc2626' } : makeUnknown ? { borderColor: '#d97706' } : undefined} />
                {!merkOk && <div className="req-note">⚠ wajib diisi</div>}
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
          <input value={nama} onChange={(e) => setNama(e.target.value)} placeholder="Nama — WAJIB" style={!namaOk ? { borderColor: '#dc2626' } : undefined} />
          {!namaOk && <div className="req-note">⚠ wajib diisi</div>}
          {regName && nama.trim() !== '' && nama.trim().toUpperCase() !== regName.toUpperCase() && (
            <div className="warn-note">⚠ Nomor ini terdaftar atas &quot;{regName}&quot; — order Turboly memakai nama terdaftar.</div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <input value={alamat} onChange={(e) => setAlamat(e.target.value)} placeholder="Alamat — WAJIB" style={!alamatOk ? { borderColor: '#dc2626' } : undefined} />
            {!alamatOk && <div className="req-note">⚠ wajib diisi — otomatis untuk customer terdaftar</div>}
          </div>
          <div className="label" style={{ marginTop: 12 }}>Yang menerima (Service Advisor)</div>
          <input list="advisor-list-q" value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder={advisors.length ? 'Pilih dari daftar / ketik' : 'Nama advisor'} style={!advisorOk ? { borderColor: '#dc2626' } : advisorUnknown ? { borderColor: '#d97706' } : undefined} />
          <datalist id="advisor-list-q">{advisors.map((a) => <option key={a.code} value={a.name} />)}</datalist>
          {!advisorOk && <div className="req-note">⚠ wajib — Turboly menolak order tanpa advisor</div>}
          {advisorUnknown && <div className="warn-note">⚠ Tidak ada di daftar advisor cabang — harus sama persis dengan nama di Turboly, atau order gagal.</div>}
          <div className="label" style={{ marginTop: 12 }}>Keluhan</div>
          <textarea value={keluhan} onChange={(e) => setKeluhan(e.target.value)} rows={2} placeholder="Keluhan customer" />
        </div>

        <div className="card">
          <div className="label">Pengecekan bodi — ketuk bagian yang rusak {dmg.size > 0 ? `(${dmg.size} ditandai)` : ''}</div>
          <svg className="car" viewBox="0 0 360 520" style={{ display: 'block', margin: '0 auto', width: '100%', maxWidth: 300 }}>
            {[[40, 70], [320, 70], [40, 450], [320, 450]].map(([wx, wy], i) => (
              <circle key={i} cx={wx} cy={wy} r="27" fill="#3a3a3a" />
            ))}
            <rect x="80" y="8" width="200" height="500" rx="34" fill="#f7faff" stroke="var(--nawilis)" strokeWidth="1.5" />
            {DAMAGE_ZONES.map((z) => {
              const cx = z.shape === 'circle' ? z.cx : z.x + z.w / 2;
              const cy = z.shape === 'circle' ? z.cy : z.y + z.h / 2;
              const on = dmg.has(z.code);
              return (
                <g key={z.code} onClick={() => toggleDmg(z.code)} style={{ cursor: 'pointer' }}>
                  {z.shape === 'circle' ? (
                    <circle className={`zone ${on ? 'on' : ''}`} cx={z.cx} cy={z.cy} r={z.r}><title>{z.label}</title></circle>
                  ) : (
                    <rect className={`zone ${on ? 'on' : ''}`} x={z.x} y={z.y} width={z.w} height={z.h} rx="2"><title>{z.label}</title></rect>
                  )}
                  <text x={cx} y={cy + 3} textAnchor="middle" fontSize="8" fill={z.shape === 'circle' ? '#fff' : '#555'} pointerEvents="none">{z.abbr}</text>
                  {on && <text x={cx} y={cy + 6} textAnchor="middle" fontSize="17" fill="#e11" fontWeight="900" pointerEvents="none">✕</text>}
                </g>
              );
            })}
            <text x="180" y="518" textAnchor="middle" fontSize="10" fill="#888" pointerEvents="none">↑ DEPAN</text>
          </svg>
          {dmg.size > 0 && (
            <div className="warn-note">Ditandai: {[...dmg].map((z) => DAMAGE_ZONES.find((d) => d.code === z)?.label ?? z).join(', ')}</div>
          )}
        </div>

        <div className="card">
          <div className="label">Tanda tangan</div>
          <div className="label" style={{ fontSize: 11, marginTop: 6 }}>Yang menyerahkan (customer) — WAJIB</div>
          <SignaturePad ref={sigCust} onInk={setCustSigned} />
          {!custSigned && <div className="req-note">⚠ tanda tangan customer wajib (persetujuan pengerjaan)</div>}
          <div className="label" style={{ fontSize: 11, marginTop: 10 }}>Yang menerima (Service Advisor) — opsional</div>
          <SignaturePad ref={sigAdv} />
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
          {submitting ? 'Menyimpan…' : 'Simpan & Kirim ke Turboly'}
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
