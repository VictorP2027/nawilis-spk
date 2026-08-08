'use client';

import BrandMark from './components/BrandMark';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FuelGauge } from './components/FuelGauge';
import { DiagramInk, type InkHandle } from './components/DiagramInk';
import { CarDiagram } from './components/CarDiagram';
import { SERVICES, BRANCHES, CONDITION_ITEMS } from '../lib/refdata.client';
import { ProductInput } from '../lib/productSuggest';
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
  /** '' only while the operator is mid-edit; coerced to ≥1 at blur/submit. */
  qty: number | '';
  sku?: string;
  /** merk / tipe, for the rows the paper wants it on (Oli, Balancing on the Car). */
  brandType?: string;
  /** "SKU Name" chosen from the dropdown's catalog groups — kept so the select
   * SHOWS the pick instead of snapping back to the jasa (which read as "it
   * didn't take"). The jasa remains the ordered SKU underneath. */
  catalogPick?: string;
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
  const router = useRouter();
  // Signatures moved to PAPER: submit redirects to the print page and both
  // parties sign the printout. No pads, no on-glass images.
  // Fuel indicator (required): blocked 0–100 bar, or EV battery % as a number.
  const [fuelMode, setFuelMode] = useState<'fuel' | 'ev'>('fuel');
  const [fuelPct, setFuelPct] = useState<number | null>(null);
  const [evPct, setEvPct] = useState('');
  // Two handwriting rows — free text or a pick from the jasa catalog.
  const [extra1, setExtra1] = useState('');
  const [extra2, setExtra2] = useState('');
  // Mobil / Motor: four make names are BOTH brands; this picks the model list
  // and Turboly's vehicle type for a new vehicle.
  const [kind, setKind] = useState<'car' | 'motorcycle'>('car');
  // Freehand red-ink annotation over the diagram (the 'annotate like a
  // signature' ask): tap-mode and draw-mode are explicit so a scroll swipe
  // can never paint, and a stray tap in draw-mode never marks a zone.
  const [dmgInked, setDmgInked] = useState(false);
  const dmgInk = useRef<InkHandle>(null);
  // Pengecekan awal (paper section, required): every item answered; OK default,
  // tap to mark the exception.
  const [condQ, setCondQ] = useState<Record<string, string>>(() => Object.fromEntries(CONDITION_ITEMS.map((c) => [c.code, 'OK'])));
  const [estimasi, setEstimasi] = useState('');
  const [optOpen, setOptOpen] = useState(false); // optional fields collapsed = neat form
  const [outbox, setOutbox] = useState(0);
  const [showSetup, setShowSetup] = useState(false); // reopened via the topbar branch badge
  const [jadwalOn, setJadwalOn] = useState(false);
  const [tglJadwal, setTglJadwal] = useState('');
  const [jamJadwal, setJamJadwal] = useState('');
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [makeKnown, setMakeKnown] = useState(false);
  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
  const [salespeople, setSalespeople] = useState<{ code: string; name: string }[]>([]);
  const [salesperson, setSalesperson] = useState('');
  const [svcOpts, setSvcOpts] = useState<Record<string, { defaultSku: string; options: { sku: string; label: string }[] }>>({});
  // Full product catalogs (OLM oils, BAN tires) for the brandType tiles' merged
  // dropdown — fetched once per category the first time such a tile turns on.
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const cats = Object.keys(jobs)
      .flatMap((code) => SERVICES.find((s) => s.code === code)?.catalog ?? [])
      .filter((c) => !(c in catalog));
    for (const cat of cats) {
      setCatalog((p) => ({ ...p, [cat]: [] })); // claim before the fetch lands
      fetch(`/api/products?cat=${cat}&limit=300`)
        .then((r) => r.json())
        .then((d: { products?: Array<{ sku: string; name: string }> }) => setCatalog((p) => ({ ...p, [cat]: (d.products ?? []).map((x) => `${x.sku} ${x.name}`) })))
        .catch(() => undefined);
    }
  }, [jobs, catalog]);

  useEffect(() => {
    fetch('/api/vehicle-makes').then((r) => r.json()).then((d) => setMakes(d.makes ?? [])).catch(() => {});
    fetch('/api/service-options').then((r) => r.json()).then((d) => setSvcOpts(d.services ?? {})).catch(() => {});
  }, []);
  useEffect(() => {
    const m = merk.trim();
    if (!m) { setModels([]); setMakeKnown(false); return; }
    let live = true;
    fetch(`/api/vehicle-models?make=${encodeURIComponent(m)}&kind=${kind}`).then((r) => r.json())
      .then((d) => { if (live) { setModels(d.models ?? []); setMakeKnown(!!d.known); } }).catch(() => {});
    return () => { live = false; };
  }, [merk, kind]);
  useEffect(() => {
    if (!branch) { setAdvisors([]); setSalespeople([]); setSalesperson(''); return; }
    let live = true;
    // Both rosters are per store — a pick made under the previous branch must
    // not survive into a store where that person may not exist.
    setSalesperson('');
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`).then((r) => r.json())
      .then((d) => { if (live) { setAdvisors(d.advisors ?? []); setSalespeople(d.salespeople ?? []); } })
      .catch(() => { if (live) { setAdvisors([]); setSalespeople([]); } });
    return () => { live = false; };
  }, [branch]);

  // The salesperson follows the advisor while nobody has overridden the box,
  // then stops the moment a name is chosen by hand (a ref, so no effect loop).
  const salesAuto = useRef(true);
  useEffect(() => {
    if (!salespeople.length) return;
    setSalesperson((prev) => {
      if (prev && !salesAuto.current) return prev;
      const m = salespeople.find((s) => s.name.toUpperCase() === advisor.trim().toUpperCase());
      return m ? m.name : '';
    });
  }, [advisor, salespeople]);
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

  function toggleJob(code: string, label: string) {
    setJobs((prev) => {
      const next = { ...prev };
      if (next[code]) delete next[code];
      else next[code] = { code, label, qty: 1 };
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
        kind,
      },
      complaint: keluhan || null,
      // Price is deliberately NOT captured at intake anymore: Turboly's own
      // pricebook prices the SO line, and the real figure is confirmed by a
      // human at Buat Invoice — which is also where the payment amount is set.
      jobLines: [...Object.values(jobs).map((j) => ({ serviceCode: j.code, ordered: true, qty: Number(j.qty) || 1, quotedPrice: null,
      chosenSku: j.sku || svcOpts[j.code]?.defaultSku || null,
      // Merk/tipe rides in keterangan, the free-text the paper form itself
      // uses for it ("Castrol Edge 5/30") — it lands on the Turboly line note.
      keterangan: j.brandType?.trim() || undefined })),
      // The handwriting rows ride as UNMAPPED job lines: the typed text IS the
      // serviceCode, so it lands verbatim in the SO's Notes ("Pekerjaan lain").
      ...[extra1, extra2].map((t) => t.trim()).filter(Boolean).map((t) => ({ serviceCode: t, ordered: true, qty: 1, quotedPrice: null, chosenSku: null }))],
      attachments: (() => { const ink = dmgInk.current?.get(); return ink ? [{ kind: 'damage', ref: ink }] : []; })(),
      raw: {
        service_lain: [extra1, extra2].map((t) => t.trim()).filter(Boolean).join(', '),
        bahan_bakar_mode: fuelMode,
        bahan_bakar_pct: fuelMode === 'fuel' ? fuelPct : Number(evPct),
      },
      conditionChecks: CONDITION_ITEMS.map((c) => ({ item: c.code, marks: condQ[c.code] === 'OK' ? [] : [condQ[c.code]!] })),
      estimasiMinutes: Number(estimasi),
      scheduledAt: jadwalOn && tglJadwal && jamJadwal && Date.parse(`${tglJadwal}T${jamJadwal}`) > Date.now() ? new Date(`${tglJadwal}T${jamJadwal}`).toISOString() : undefined,
      serviceAdvisorName: advisor || null,
      salespersonName: effSalesperson || null,
      signatures: {
        // Consent is given on the PRINTED form now — presence true with no
        // image = wet_signature basis; the names still print under the boxes.
        menyerahkanPresent: true,
        menyerahkanNamaJelas: nama || null,
        menerimaPresent: !!advisor,
        menerimaNamaJelas: advisor || null,
        menyerahkanImage: null,
        menerimaImage: null,
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
        // Straight to the printout — that is where the customer signs now.
        resetForm();
        router.push(`/spk/${body.spkId}/print?print=1`);
        return;
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
    setCondQ(Object.fromEntries(CONDITION_ITEMS.map((c) => [c.code, 'OK'])));
    setEstimasi('');
    setFuelMode('fuel'); setFuelPct(null); setEvPct('');
    setExtra1(''); setExtra2('');
    setKind('car');
    dmgInk.current?.clear();
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
  // Salesperson is mandatory in Turboly and comes from its own per-store list;
  // an unloaded roster falls back to the advisor rather than locking the branch.
  const salespersonKnown = salespeople.length > 0;
  const effSalesperson = salespersonKnown ? salesperson.trim() : advisor.trim();
  const salespersonOk = effSalesperson !== '';
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
  const tipeOk = tipe.trim() !== '';
  const jobsOk = Object.keys(jobs).length > 0; // an SO with zero service items is impossible
  const estimasiOk = /^\d+$/.test(estimasi.trim()) && Number(estimasi) > 0;
  const fuelOk = fuelMode === 'fuel' ? fuelPct !== null : /^\d{1,3}$/.test(evPct.trim()) && Number(evPct) <= 100;
  const canSubmit = !!branch && waOk && advisorOk && salespersonOk && alamatOk && plateOk && namaOk && merkOk && warnaOk && kmOk && tahunOk && tipeOk && estimasiOk && jobsOk && fuelOk && !submitting;
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
        <BrandMark page="SPK" />
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
          {waOk && <div className="ok-sm">✓ {waE164Preview}{custHint ? ` · ↩ ${custHint}` : ''}{custVehicles.length > 1 ? ' — pilih mobil:' : ''}</div>}
          {custHint && (
            <div>
              {custVehicles.length > 1 && (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {custVehicles.map((v) => (
                    <button key={v.plate} type="button" className="btn ghost" style={{ fontSize: 11, padding: '4px 8px' }}
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
            <div className="ok-sm" style={{ color: '#55627a' }}>
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
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            {(['car', 'motorcycle'] as const).map((k) => (
              <button key={k} type="button" className={`chk-chip${kind === k ? ' ok' : ''}`} onClick={() => setKind(k)}>
                {k === 'car' ? '🚗 Mobil' : '🏍 Motor'}
              </button>
            ))}
          </div>
          <div className="label">Merk</div>
                <input list="make-list-q" value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="Toyota — WAJIB" style={!merkOk ? { borderColor: '#dc2626' } : makeUnknown ? { borderColor: '#d97706' } : undefined} />
                {!merkOk && <div className="req-note">⚠ wajib diisi</div>}
                <datalist id="make-list-q">{makes.map((m) => <option key={m} value={m} />)}</datalist>
                {makeUnknown && <div className="warn-note">⚠ Merk tidak ada di katalog Turboly — boleh lanjut.</div>}
              </div>
              <div>
                <div className="label">Tipe</div>
                <input list="model-list-q" value={tipe} onChange={(e) => setTipe(e.target.value)} placeholder="Avanza — WAJIB" style={!tipeOk ? { borderColor: '#dc2626' } : modelUnknown ? { borderColor: '#d97706' } : undefined} />
                {!tipeOk && <div className="req-note">⚠ wajib diisi</div>}
                <datalist id="model-list-q">{models.map((m) => <option key={m} value={m} />)}</datalist>
                {modelUnknown && <div className="warn-note">⚠ Tipe tidak ada di daftar {merk.trim().toUpperCase()} — dipetakan ke model paling mirip saat kirim.</div>}
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <FuelGauge mode={fuelMode} pct={fuelPct} ev={evPct} onMode={setFuelMode} onPct={setFuelPct} onEv={setEvPct} />
        </div>

        <div className="card">
          <div className="label">Pekerjaan</div>
          {!jobsOk && <div className="req-note">⚠ pilih minimal satu pekerjaan — order Turboly tidak bisa dibuat tanpa service item</div>}
          <div className="tiles">
            {SERVICES.map((s) => {
              const on = !!jobs[s.code];
              return (
                <button key={s.code} type="button" className={`tile ${on ? 'on' : ''}`} onClick={() => toggleJob(s.code, s.label)}>
                  {s.label}
                  {/* The unit comes off the printed sheet: a tick is a tick, but
                      Balancing/Ban/Nitrogen are ordered in PCS and Oli in LITER —
                      the count is the order, so it gets a field, not a default 1. */}
                  {on && s.unit !== 'check' && (
                    <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                      <input
                        type="number"
                        min={1}
                        value={jobs[s.code]!.qty}
                        onChange={(e) => { const v = e.target.value; setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, qty: v === '' ? '' : Math.max(1, Math.floor(Number(v)) || 1) } })); }}
                        onBlur={() => setJobs((p) => (p[s.code]?.qty === '' ? { ...p, [s.code]: { ...p[s.code]!, qty: 1 } } : p))}
                        style={{ width: 64, fontSize: 12, padding: '6px 8px' }}
                      />
                      <span style={{ fontSize: 11, color: 'var(--muted, #667)' }}>{s.unit}</span>
                    </span>
                  )}
                  {on && s.catalog?.length ? (
                    // The catalog box: tap-to-open list of what the tenant
                    // actually stocks for this card. Free text still wins —
                    // the catalog offers, never constrains.
                    <span onClick={(e) => e.stopPropagation()} style={{ display: 'block', marginTop: 6 }}>
                      <ProductInput
                        cat={s.catalog[0]!}
                        value={jobs[s.code]!.brandType ?? ''}
                        onChange={(v) => setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, brandType: v, catalogPick: undefined } }))}
                        placeholder={s.code === 'OLI' ? 'merk / tipe — contoh: Castrol Edge 5W-30' : 'merk / tipe — pilih atau ketik'}
                        style={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
                      />
                    </span>
                  ) : null}
                  {on && svcOpts[s.code]?.options?.length ? (
                    // brandType tiles carry the WHOLE catalog inside this one
                    // dropdown: the jasa lines first, then every OLM oil / BAN
                    // tire. Picking a catalog entry does not change the sku —
                    // it fills the merk/tipe box above (the oil is keterangan
                    // on the Turboly line, the jasa is the line itself).
                    <select
                      value={jobs[s.code]!.catalogPick ? `katalog::${jobs[s.code]!.catalogPick}` : (jobs[s.code]!.sku || svcOpts[s.code]!.defaultSku)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith('katalog::')) {
                          const pick = v.slice(9);
                          // The box (and the keterangan it feeds) reads like a
                          // person wrote it: the product NAME. The SKU stays
                          // visible where it belongs — on the dropdown option.
                          setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, brandType: pick.replace(/^\S+\s+/, ''), catalogPick: pick } }));
                        } else {
                          setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, sku: v, catalogPick: undefined } }));
                        }
                      }}
                      style={{ marginTop: 6, fontSize: 12, padding: '6px 8px', maxWidth: '100%' }}
                    >
                      {s.catalog?.length ? (
                        <>
                          <optgroup label="Jasa (SKU order)">
                            {svcOpts[s.code]!.options.map((o) => <option key={o.sku} value={o.sku}>{o.label}</option>)}
                          </optgroup>
                          {s.catalog.map((cat) => (
                            <optgroup key={cat} label={`Katalog ${cat.replace(/_/g, ' ')} — pilih, masuk ke merk/tipe`}>
                              {(catalog[cat] ?? []).map((n) => (
                                <option key={`${cat}:${n}`} value={`katalog::${n}`}>{n}</option>
                              ))}
                            </optgroup>
                          ))}
                        </>
                      ) : (
                        svcOpts[s.code]!.options.map((o) => <option key={o.sku} value={o.sku}>{o.label}</option>)
                      )}
                    </select>
                  ) : null}
                </button>
              );
            })}
          </div>
          {/* Two blank rows, exactly like the paper's 13/14: pick from the jasa
              list or handwrite anything — either way it reaches the order. */}
          <div className="label" style={{ marginTop: 10 }}>Pekerjaan lain (tulis / pilih)</div>
          <input list="jasa-all" value={extra1} onChange={(e) => setExtra1(e.target.value)} placeholder="Pekerjaan lain 1…" />
          <input list="jasa-all" value={extra2} onChange={(e) => setExtra2(e.target.value)} placeholder="Pekerjaan lain 2…" style={{ marginTop: 4 }} />
          <datalist id="jasa-all">
            {[...new Set(Object.values(svcOpts).flatMap((o) => o.options.map((x) => x.label)))].map((l) => <option key={l} value={l} />)}
          </datalist>
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
          {/* Turboly stars Salesperson exactly like Service Advisor, and fills
              it from a different per-store roster — a select, because unlike the
              advisor there is no "new salesperson" case to type. */}
          <div className="label" style={{ marginTop: 12 }}>Salesperson — WAJIB</div>
          {salespersonKnown ? (
            <select value={salesperson} onChange={(e) => { salesAuto.current = false; setSalesperson(e.target.value); }} style={!salespersonOk ? { borderColor: '#dc2626' } : undefined}>
              <option value="">— pilih salesperson —</option>
              {salespeople.map((s) => <option key={s.code} value={s.name}>{s.name}</option>)}
            </select>
          ) : (
            <div className="warn-note">⚠ {branch ? 'Daftar salesperson cabang ini kosong' : 'Pilih cabang dulu'} — order memakai nama advisor.</div>
          )}
          {salespersonKnown && advisor.trim() !== '' && !salespeople.some((s) => s.name.toUpperCase() === advisor.trim().toUpperCase()) && (
            <div className="warn-note">⚠ {advisor.trim()} tidak terdaftar sebagai Salesperson di cabang ini — pilih orang lain untuk kolom ini.</div>
          )}
          {!salespersonOk && <div className="req-note">⚠ wajib — Turboly menolak order tanpa salesperson</div>}
        </div>

        {/* Optional fields collapsed behind one toggle — keeps the form neat. */}
        <button type="button" className="btn ghost" style={{ width: '100%', marginBottom: 14 }} onClick={() => setOptOpen((o) => !o)}>
          {optOpen ? '▾' : '▸'} Opsional: keluhan
          {!optOpen && keluhan.trim() ? ' — terisi' : ''}
        </button>

        {optOpen && (
        <div className="card">
          <div className="label">Keluhan</div>
          <textarea value={keluhan} onChange={(e) => setKeluhan(e.target.value)} rows={2} placeholder="Keluhan customer" />
        </div>
        )}

        {/* The body diagram, redrawn to match the printed SPK line for line.
            Annotation is PEN-ONLY — draw on it exactly like on the paper; the
            ink ships as a transparent PNG and prints back over this same art. */}
        <div className="card">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="label" style={{ marginBottom: 0 }}>Pengecekan bodi — ✏ gambar kerusakan langsung</span>
            {dmgInked && <button type="button" className="chk-chip" onClick={() => { dmgInk.current?.clear(); }}>✕ Hapus gambar</button>}
          </div>
          <div style={{ position: 'relative', margin: '0 auto', maxWidth: 300 }}>
            <CarDiagram />
            <DiagramInk ref={dmgInk} active onInk={setDmgInked} />
          </div>
        </div>

        <div className="card">
          <div className="label">Pengecekan awal — ketuk jika ada temuan</div>
          <div className="chk-grid">
            {CONDITION_ITEMS.map((c) => (
              <div key={c.code} className="chk-row">
                <span className="chk-label">{c.label}</span>
                {['OK', ...c.marks].map((m) => (
                  <button key={m} type="button" className={`chk-chip ${condQ[c.code] === m ? (m === 'OK' ? 'ok' : 'bad') : ''}`} onClick={() => setCondQ((prev) => ({ ...prev, [c.code]: m }))}>{m}</button>
                ))}
              </div>
            ))}
          </div>
          <div className="label" style={{ marginTop: 12 }}>Estimasi waktu pekerjaan (menit) — WAJIB</div>
          <input value={estimasi} onChange={(e) => setEstimasi(e.target.value)} inputMode="numeric" placeholder="60" style={!estimasiOk ? { borderColor: '#dc2626', maxWidth: 140 } : { maxWidth: 140 }} />
          {!estimasiOk && <div className="req-note">⚠ wajib — angka menit, contoh 60</div>}
        </div>

        <div className="card">
          <div className="label">Tanda tangan</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Setelah Simpan, formulir cetak terbuka otomatis — customer dan penerima
            tanda tangan di kertas.
          </div>
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
