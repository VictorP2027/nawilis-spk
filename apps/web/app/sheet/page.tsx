'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FuelGauge } from '../components/FuelGauge';
import { DiagramInk, type InkHandle } from '../components/DiagramInk';
import { CarDiagram } from '../components/CarDiagram';
import { SERVICES, BRANCHES, CONDITION_ITEMS } from '../../lib/refdata.client';
import { useBranches } from '../../lib/branches.client';
import { submitOrQueue } from '../../lib/outbox';

/** Pixel-faithful, fillable replica of the Nawilis SPK (Surat Perintah Kerja). */
function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}


/** Turboly base for "add it there" deep-links (switch via env at prod go-live). */
const TURBOLY_URL = process.env.NEXT_PUBLIC_TURBOLY_BASE_URL ?? 'https://live.turboly.com';

interface PkRow { order: boolean; qty: number | ''; keterangan: string; mk: string; waktu: string; sku?: string }
interface SvcOpt { defaultSku: string; options: { sku: string; label: string }[] }

export default function Sheet() {
  const [serial, setSerial] = useState('');
  const [tanggal, setTanggal] = useState('');
  // Opt-in scheduling: hidden by default; walk-ins keep Turboly plan = now+30m.
  const [jadwalOn, setJadwalOn] = useState(false);
  const [tglJadwal, setTglJadwal] = useState('');
  const [jamJadwal, setJamJadwal] = useState('');
  const [nama, setNama] = useState('');
  const [alamat, setAlamat] = useState('');
  const [wa, setWa] = useState('');
  const [merk, setMerk] = useState('');
  const [tipe, setTipe] = useState('');
  const [noPol, setNoPol] = useState('');
  const [tahun, setTahun] = useState('');
  const [warna, setWarna] = useState('');
  const [km, setKm] = useState('');
  const [keluhan, setKeluhan] = useState('');
  const [estimasi, setEstimasi] = useState('');
  const [rekom, setRekom] = useState('');
  const [kontakLain, setKontakLain] = useState('');
  const [menyerahkan, setMenyerahkan] = useState('');
  const [menerima, setMenerima] = useState('');
  const router = useRouter();
  const [fuelMode, setFuelMode] = useState<'fuel' | 'ev'>('fuel');
  const [fuelPct, setFuelPct] = useState<number | null>(null);
  const [evPct, setEvPct] = useState('');
  const [kind, setKind] = useState<'car' | 'motorcycle'>('car');
  const [dmgInked, setDmgInked] = useState(false);
  const dmgInk = useRef<InkHandle>(null);
  const [branch, setBranch] = useState('');
  // Compiled-in list, plus any branch opened since the last deploy.
  const BRANCHES = useBranches();
  const [extra1, setExtra1] = useState('');
  const [extra2, setExtra2] = useState('');
  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
  const [salespeople, setSalespeople] = useState<{ code: string; name: string }[]>([]);
  const [salesperson, setSalesperson] = useState('');
  const [svcOpts, setSvcOpts] = useState<Record<string, SvcOpt>>({});

  // Per-service Turboly variant options (form dropdowns; default pre-selected).
  useEffect(() => {
    fetch('/api/service-options').then((r) => r.json()).then((d) => setSvcOpts(d.services ?? {})).catch(() => {});
  }, []);

  // Turboly's real vehicle-make catalog → Merk datalist (made-up makes can't push).
  const [makes, setMakes] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/vehicle-makes').then((r) => r.json()).then((d) => setMakes(d.makes ?? [])).catch(() => {});
  }, []);

  // Models for the chosen make → Tipe datalist (list of available cars).
  const [models, setModels] = useState<string[]>([]);
  const [makeKnownInModels, setMakeKnownInModels] = useState(false);
  useEffect(() => {
    const m = merk.trim();
    if (!m) { setModels([]); setMakeKnownInModels(false); return; }
    let live = true;
    fetch(`/api/vehicle-models?make=${encodeURIComponent(m)}&kind=${kind}`)
      .then((r) => r.json())
      .then((d) => { if (live) { setModels(d.models ?? []); setMakeKnownInModels(!!d.known); } })
      .catch(() => { if (live) { setModels([]); setMakeKnownInModels(false); } });
    return () => { live = false; };
  }, [merk, kind]);

  /** Operator confirmation: this is a genuinely NEW make — create it in Turboly at push. */
  const [createMakeOk, setCreateMakeOk] = useState(false);
  useEffect(() => { setCreateMakeOk(false); }, [merk]); // re-confirm if the make text changes

  // Live overridable warnings: typing anything is allowed, but flag values that
  // aren't in Turboly's catalog so staff can fix a typo before submitting.
  const makeUnknown = merk.trim() !== '' && makes.length > 0 && !makes.some((m) => m.toUpperCase() === merk.trim().toUpperCase());
  const modelUnknown = tipe.trim() !== '' && makeKnownInModels && models.length > 0 && !models.some((m) => m.toUpperCase() === tipe.trim().toUpperCase());

  // Live field checks (warn at the field itself — the person filling can see and
  // simply continue; there is NO submit-time gate).
  const plateNorm = noPol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const plateBad = noPol.trim() !== '' && !/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(plateNorm);
  const kmVal = /\d/.test(km) ? Number(km.replace(/[.\s]/g, '').replace(/,/g, '')) : NaN;
  const kmWarn = km.trim() === '' ? null
    : Number.isNaN(kmVal) ? 'KM tidak terbaca'
    : kmVal < 0 ? 'KM negatif'
    : kmVal > 2_000_000 ? `KM ${kmVal.toLocaleString('id-ID')} sangat tinggi — periksa` : null;
  const yearNow = new Date().getFullYear();
  const tahunWarn = tahun !== '' && (Number(tahun) < 1950 || Number(tahun) > yearNow + 1) ? `Tahun di luar batas wajar (1950–${yearNow + 1})` : null;

  // Plate → history: KM check + returning-customer prefill (fills EMPTY fields only).
  const [prevVisitKm, setPrevVisitKm] = useState<number | null>(null);
  const [plateOwner, setPlateOwner] = useState<{ nama: string; wa: string | null } | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  useEffect(() => {
    if (!plateNorm || plateBad) { setPrevVisitKm(null); setReturning(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/vehicle?plate=${encodeURIComponent(plateNorm)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!live) return;
          setPrevVisitKm(d?.vehicle?.lastKm ?? null);
          setPlateOwner(d?.customer ?? null);
          const v = d?.vehicle, cu = d?.customer;
          if (v) {
            setMerk((x) => x || v.merk || '');
            setTipe((x) => x || v.tipe || '');
            setTahun((x) => x || (v.tahun ? String(v.tahun) : ''));
            setWarna((x) => x || v.warna || '');
          }
          if (cu) {
            setNama((x) => x || cu.nama || '');
            setWa((x) => x || cu.wa || '');
            setAlamat((x) => x || cu.alamat || '');
            setReturning(`${cu.nama}${cu.wa ? ` · ${cu.wa}` : ''}${v?.lastKm != null ? ` · terakhir ${Number(v.lastKm).toLocaleString('id-ID')} km` : ''}`);
          } else setReturning(null);
        })
        .catch(() => { if (live) { setPrevVisitKm(null); setReturning(null); } });
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [plateNorm, plateBad]);
  const kmBelowPrev = prevVisitKm != null && !Number.isNaN(kmVal) && kmVal < prevVisitKm;
  const canonK = (s: string) => s.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
  const ownerMismatch = !!plateOwner?.wa && canonK(wa).length >= 8 && canonK(plateOwner.wa) !== canonK(wa);

  // PHONE-FIRST lookup: typing the WhatsApp number auto-populates the person and
  // their car(s); vehicles stay fully editable, chips switch between their cars.
  const [custVehicles, setCustVehicles] = useState<Array<{ plate: string; merk: string | null; tipe: string | null; tahun: number | null; warna: string | null }>>([]);
  const [custHint, setCustHint] = useState<string | null>(null);
  const [regName, setRegName] = useState<string | null>(null); // name originally linked to the phone
  useEffect(() => {
    const digits = wa.replace(/\D/g, '');
    if (digits.length < 9) { setCustVehicles([]); setCustHint(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/customer?phone=${encodeURIComponent(wa)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!live) return;
          if (d?.customer) {
            // The phone's ORIGINAL registered name wins (identity = phone).
            setRegName(d.customer.nama || null);
            if (d.customer.nama) setNama(d.customer.nama);
            setAlamat((x) => x || d.customer.alamat || '');
            const vs = d.vehicles ?? [];
            setCustVehicles(vs);
            setCustHint(`${d.customer.nama} — ${vs.length} kendaraan tercatat`);
            const v = vs[0];
            if (v && !noPol && !merk && !tipe) {
              setNoPol(v.plate); setMerk(v.merk ?? ''); setTipe(v.tipe ?? '');
              setTahun(v.tahun ? String(v.tahun) : ''); setWarna(v.warna ?? '');
            }
          } else { setCustVehicles([]); setCustHint(null); setRegName(null); }
        })
        .catch(() => { if (live) { setCustVehicles([]); setCustHint(null); setRegName(null); } });
    }, 500);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wa]);
  const pickVehicle = (v: { plate: string; merk: string | null; tipe: string | null; tahun: number | null; warna: string | null }) => {
    setNoPol(v.plate); setMerk(v.merk ?? ''); setTipe(v.tipe ?? '');
    setTahun(v.tahun ? String(v.tahun) : ''); setWarna(v.warna ?? '');
  };
  const advisorUnknown = menerima.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === menerima.trim().toUpperCase());
  // Salesperson is mandatory in Turboly, from its own per-store roster; an
  // unloaded roster falls back to the advisor rather than locking the branch.
  const salespersonKnown = salespeople.length > 0;
  const effSalesperson = salespersonKnown ? salesperson.trim() : menerima.trim();

  // Load the real service advisors for the chosen branch (synced from Turboly).
  useEffect(() => {
    if (!branch) { setAdvisors([]); setSalespeople([]); setSalesperson(''); return; }
    let live = true;
    // Both rosters are per store — a pick from the previous branch must not
    // survive into a store where that person may not exist.
    setSalesperson('');
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`)
      .then((r) => r.json())
      .then((d) => { if (live) { setAdvisors(d.advisors ?? []); setSalespeople(d.salespeople ?? []); } })
      .catch(() => { if (live) { setAdvisors([]); setSalespeople([]); } });
    return () => { live = false; };
  }, [branch]);


  const [pk, setPk] = useState<Record<string, PkRow>>(() =>
    Object.fromEntries(SERVICES.map((s) => [s.code, { order: false, qty: 1, keterangan: '', mk: '', waktu: '' }])),
  );
  // Raw detail fields that map 1:1 to the Nawilis export columns.
  // A set, not one choice: a panel is often baret AND penyok. Empty = OK.
  const [cond, setCond] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(CONDITION_ITEMS.map((c) => [c.code, [] as string[]])),
  );
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setRow = (code: string, patch: Partial<PkRow>) => setPk((p) => ({ ...p, [code]: { ...p[code]!, ...patch } }));

  const orderedCount = useMemo(() => Object.values(pk).filter((r) => r.order).length, [pk]);

  async function submit() {
    setSubmitting(true);
    setResult(null);
    const uploadId = uuid();
    const jobLines = SERVICES.filter((s) => pk[s.code]!.order).map((s) => {
      const r = pk[s.code]!;
      const notes = [r.keterangan, r.mk && `MK:${r.mk}`, r.waktu && `Waktu:${r.waktu}`].filter(Boolean).join(' ');
      // Price is not captured at intake: Turboly's pricebook prices the line,
      // and the human-confirmed figure enters at Buat Invoice on the board.
      return { serviceCode: s.code, ordered: true, qty: Number(r.qty) || 1, keterangan: notes || null, quotedPrice: null, chosenSku: r.sku || svcOpts[s.code]?.defaultSku || null };
    });
    for (const t of [extra1, extra2].map((x) => x.trim()).filter(Boolean)) {
      // Handwriting rows: the text IS the serviceCode — unmapped, so it lands
      // verbatim in the SO's Notes ("Pekerjaan lain").
      jobLines.push({ serviceCode: t, ordered: true, qty: 1, keterangan: null, quotedPrice: null, chosenSku: null });
    }
    const conditionChecks = CONDITION_ITEMS.map((c) => ({ item: c.code, marks: cond[c.code] ?? [] }));
    const complaint = keluhan || null;

    const payload = {
      uploadId,
      docType: 'SPK_NAWILIS',
      branchCode: branch,
      captureMode: 'typed',
      operatorUserId: menerima || 'unattributed',
      operatorPinVerified: !!menerima,
      deviceBindingVerified: true,
      spkNumber: serial || null,
      capturedAt: new Date().toISOString(),
      arrivalTime: tanggal ? new Date(tanggal).toISOString() : undefined,
      // Opt-in appointment → Turboly Plan Service Date/Time; else push uses now+30m.
      scheduledAt: jadwalOn && tglJadwal && jamJadwal && Date.parse(`${tglJadwal}T${jamJadwal}`) > Date.now() ? new Date(`${tglJadwal}T${jamJadwal}`).toISOString() : undefined,
      customer: { nama, wa: wa || null, alamat: alamat || null, kontakLain: kontakLain || null },
      vehicle: { noPolisi: noPol, merk: merk || null, tipe: tipe || null, tahun: tahun ? Number(tahun) : null, warna: warna || null, km, createMakeConfirmed: makeUnknown && createMakeOk, kind },
      complaint,
      jobLines,
      conditionChecks,
      rekomendasiService: rekom || null,
      estimasiMinutes: estimasi ? Number(estimasi) : null,
      serviceAdvisorName: menerima || null,
      salespersonName: effSalesperson || null,
      signatures: {
        // Signing happens on the PRINTED form now — presence without an image
        // records the wet_signature basis; names still print under the boxes.
        menyerahkanPresent: true,
        menyerahkanNamaJelas: menyerahkan || null,
        menerimaPresent: !!menerima,
        menerimaNamaJelas: menerima || null,
        menyerahkanImage: null,
        menerimaImage: null,
      },
      // Verbatim raw fields → reproduce the Nawilis export columns exactly.
      // (DETAIL TAMBAHAN removed 2026-08-08 — its export columns stay empty.)
      attachments: (() => { const ink = dmgInk.current?.get(); return ink ? [{ kind: 'damage', ref: ink }] : []; })(),
      raw: {
        nama_cs: menerima, kontak_lainnya: kontakLain, nama_customer_menyerahkan: menyerahkan,
        service_lain: [extra1, extra2].filter(Boolean).join(', '),
        bahan_bakar_mode: fuelMode,
        bahan_bakar_pct: fuelMode === 'fuel' ? fuelPct : Number(evPct),
      },
    };

    // Branch routes the Turboly store; WA is REQUIRED (customer identity key).
    // Everything else is allowed through — the server warns instead of refusing.
    if (!branch) { setResult({ ok: false, text: 'Pilih cabang dulu (di bawah).' }); setSubmitting(false); return; }
    const waNatS = wa.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    if (!/^8\d{8,11}$/.test(waNatS)) { setResult({ ok: false, text: 'Nomor WhatsApp Indonesia (+62) wajib — mulai 08… atau +62 8…, contoh 08123456789.' }); setSubmitting(false); return; }
    if (!menerima.trim()) { setResult({ ok: false, text: 'Yang menerima (Service Advisor) wajib diisi — Turboly menolak order tanpa advisor.' }); setSubmitting(false); return; }
    if (!effSalesperson) { setResult({ ok: false, text: 'Salesperson wajib dipilih — Turboly menolak order tanpa salesperson.' }); setSubmitting(false); return; }
    if (!alamat.trim()) { setResult({ ok: false, text: 'Alamat wajib diisi (terisi otomatis untuk customer terdaftar).' }); setSubmitting(false); return; }
    // Same rule as the tile form: a job picked in "Pekerjaan lain" counts, as
    // long as it carries a SKU — that is what becomes a real service line on
    // the order (payload.ts `leadingSku`). A carwash has no tile of its own.
    const jobFromText = (t: string): boolean =>
      /^[A-Z]{3}-[A-Z0-9]+-[A-Z0-9]+$/i.test((t ?? '').trim().split(/\s+/)[0] ?? '');
    if (!SERVICES.some((sv) => pk[sv.code]?.order) && ![extra1, extra2].some(jobFromText)) {
      setResult({ ok: false, text: 'Pilih minimal satu pekerjaan — order Turboly tidak bisa dibuat tanpa service item. Kalau tidak ada tombolnya (mis. cuci mobil), pilih dari "Pekerjaan lain".' });
      setSubmitting(false);
      return;
    }
    const requiredSheet: Array<[string, string]> = [[tanggal, 'Tanggal'], [noPol, 'Nomor Polisi'], [nama, 'Nama Customer'], [merk, 'Merek Mobil'], [tipe, 'Tipe'], [warna, 'Warna Mobil'], [km, 'KM'], [tahun, 'Tahun'], [estimasi, 'Estimasi waktu pekerjaan'], [menyerahkan, 'Yang menyerahkan (nama customer)']];
    const missing = requiredSheet.filter(([v]) => !String(v).trim()).map(([, label]) => label);
    if (missing.length) { setResult({ ok: false, text: `Wajib diisi: ${missing.join(', ')}.` }); setSubmitting(false); return; }
    const fuelOkS = fuelMode === 'fuel' ? fuelPct !== null : /^\d{1,3}$/.test(evPct.trim()) && Number(evPct) <= 100;
    if (!fuelOkS) { setResult({ ok: false, text: fuelMode === 'fuel' ? 'Indikator bahan bakar wajib — ketuk balok 0–100%.' : 'Sisa baterai EV wajib — isi angka 0–100.' }); setSubmitting(false); return; }

    // NO submit-time gate: warnings live at the fields themselves (the person
    // filling out sees them and simply continues) — Simpan sends immediately.
    await send(uploadId, payload);
  }

  /** Actually save + push (used by the clean path and the SIMPAN PAKSA override button). */
  async function send(uploadId: string, payload: unknown) {
    setSubmitting(true);
    try {
      const res = await submitOrQueue(uploadId, payload);
      if (res === 'queued') { setResult({ ok: true, text: '✓ Tersimpan offline — akan dikirim otomatis saat online.' }); return; }
      if (res === 'queued_no_images') { setResult({ ok: true, text: '✓ Tersimpan offline (tanda tangan gambar dilepas — penyimpanan penuh). Akan dikirim otomatis saat online.' }); return; }
      if (res === 'lost') { setResult({ ok: false, text: '✗ GAGAL menyimpan: penyimpanan perangkat penuh & tidak ada koneksi. Data TIDAK tersimpan — hubungkan internet lalu coba lagi.' }); return; }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const notes = (body.findings ?? []).map((f: { message: string }) => f.message).join('; ');
        if (!body.needsReview && body.spkId) {
          // Straight to the printout — that is where both parties sign now.
          router.push(`/spk/${body.spkId}/print?print=1`);
          return;
        }
        setResult({ ok: false, text: `Tersimpan, perlu diperbaiki: ${notes}` });
      } else setResult({ ok: false, text: body.error ?? 'Gagal menyimpan.' });
    } catch (e) {
      setResult({ ok: false, text: `Gagal menyimpan: ${(e as Error).message}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sheet-wrap">
      <div className="sheet">
        {/* Header */}
        <div className="hd">
          <div className="logo">
            <svg className="mark" viewBox="0 0 40 40" aria-label="NAWILIS">
              <rect width="40" height="40" rx="6" fill="#1E2E91" />
              <path d="M8 30 L16 10 L20 20 L24 10 L32 30 L26 30 L22 21 L20 25 L18 21 L14 30 Z" fill="#fff" />
            </svg>
            <div className="word">NAWILIS<small>SPOORING · BALANCING SPECIALIST</small></div>
          </div>
          <div className="title">
            <b>SURAT PERINTAH KERJA (S.P.K.)</b>
            <small>SAFETY &amp; COMFORT FIRST</small>
          </div>
          <div className="serial">NO. <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="202" /><div className="qr">QR</div></div>
        </div>

        {/* Customer + Vehicle */}
        <div className="two">
          <div className="box">
            <span className="sec-h">INFORMASI CUSTOMER</span>
            <div className="fld"><label>Nomor WhatsApp</label>
              <div>
                <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="Nomor WhatsApp — WAJIB, ketik dulu (08…)" style={!/^8\d{8,11}$/.test(wa.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '')) ? { borderColor: '#d97706' } : undefined} />
                {(() => { const n = wa.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, ''); return wa.trim() !== '' && !/^8\d{8,11}$/.test(n)
                  ? <div className="err-inline">⚠ Format Indonesia (+62): mulai 08… atau +62 8…, contoh 08123456789.</div>
                  : /^8\d{8,11}$/.test(n) ? <div className="ok-inline">✓ +62{n}</div> : null; })()}
                {wa.replace(/\D/g, '').length < 9 && <div className="warn-inline">⚠ Nomor WhatsApp <b>wajib</b> — identitas pelanggan (min. 9 digit).</div>}
                {custHint && (
                  <div className="ok-inline">↩ {custHint}{custVehicles.length > 1 ? ' — pilih mobil:' : ''}
                    {custVehicles.length > 1 && (
                      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                        {custVehicles.map((v) => (
                          <button key={v.plate} type="button" className="warn-btn" style={{ borderColor: '#16a34a', color: '#166534' }} onClick={() => pickVehicle(v)}>
                            {v.plate}{v.merk ? ` · ${v.merk}` : ''}{v.tipe ? ` ${v.tipe}` : ''}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="fld"><label>Tanggal</label>
              <div>
                <input type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
                {!jadwalOn && <button type="button" className="warn-btn" style={{ marginTop: 3, borderColor: '#b9c6de', color: '#33415c' }} onClick={() => setJadwalOn(true)}>🕐 Jadwalkan servis (opsional)</button>}
                {jadwalOn && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input type="date" value={tglJadwal} onChange={(e) => setTglJadwal(e.target.value)} />
                      <input type="time" value={jamJadwal} onChange={(e) => setJamJadwal(e.target.value)} />
                      <button type="button" className="warn-btn" style={{ borderColor: '#b9c6de', color: '#33415c' }} onClick={() => { setJadwalOn(false); setTglJadwal(''); setJamJadwal(''); }}>✕</button>
                    </div>
                    {tglJadwal && jamJadwal && Date.parse(`${tglJadwal}T${jamJadwal}`) > Date.now()
                      ? <div className="ok-inline">✓ Plan Service Turboly: {tglJadwal} {jamJadwal}</div>
                      : <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>Isi tanggal + jam (masa depan) — kosong = langsung (now+30 menit).</div>}
                  </div>
                )}
              </div>
            </div>
            <div className="fld"><label>Nama</label>
              <div>
                <input value={nama} onChange={(e) => setNama(e.target.value)} />
                {regName && nama.trim() !== '' && nama.trim().toUpperCase() !== regName.toUpperCase() && (
                  <div className="warn-inline">⚠ Nomor ini terdaftar atas &quot;{regName}&quot; — order Turboly memakai nama terdaftar.</div>
                )}
              </div>
            </div>
            <div className="fld"><label>Alamat</label><div>
              <input value={alamat} onChange={(e) => setAlamat(e.target.value)} style={!alamat.trim() ? { borderColor: '#d97706' } : undefined} />
              {!alamat.trim() && <div className="err-inline">⚠ Wajib diisi.</div>}
            </div></div>

          </div>
          <div className="box">
            <span className="sec-h">INFORMASI KENDARAAN</span>
            <div className="fld"><label>Jenis</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['car', 'motorcycle'] as const).map((k) => (
                  <button key={k} type="button" className={`chk-chip${kind === k ? ' ok' : ''}`} onClick={() => setKind(k)}>
                    {k === 'car' ? '🚗 Mobil' : '🏍 Motor'}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld"><label>Merk Mobil</label>
              <div>
                <input list="make-list" value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="cth: Toyota" style={makeUnknown ? { borderColor: '#d97706' } : undefined} />
                <datalist id="make-list">{makes.map((m) => <option key={m} value={m} />)}</datalist>
                {makeUnknown && !createMakeOk && (
                  <div className="warn-inline">
                    ⚠ Merk tidak ada di katalog Turboly. Periksa ejaan — atau konfirmasi bahwa ini merk BARU dan sistem akan membuatnya otomatis saat kirim:
                    <span style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      <button type="button" className="warn-btn confirm-make" onClick={() => setCreateMakeOk(true)}>✓ KONFIRMASI: buat merk baru &quot;{merk.trim().toUpperCase()}&quot;</button>
                      <a className="warn-btn" href={`${TURBOLY_URL}/vehicle_makes`} target="_blank" rel="noreferrer">➕ Tambah manual</a>
                    </span>
                  </div>
                )}
                {makeUnknown && createMakeOk && (
                  <div className="ok-inline">
                    ✓ Merk baru &quot;{merk.trim().toUpperCase()}&quot; akan DIBUAT otomatis di Turboly saat kirim.
                    <button type="button" className="warn-btn" style={{ marginLeft: 8 }} onClick={() => setCreateMakeOk(false)}>Batal</button>
                  </div>
                )}
              </div>
            </div>
            <div className="fld"><label>Tipe</label>
              <div>
                <input list="model-list" value={tipe} onChange={(e) => setTipe(e.target.value)} placeholder={models.length ? 'pilih dari daftar / ketik' : 'cth: Avanza'} style={modelUnknown ? { borderColor: '#d97706' } : undefined} />
                <datalist id="model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
                {modelUnknown && (
                  <div className="warn-inline">
                    ⚠ Tipe tidak ada di daftar model {merk.trim().toUpperCase()} di Turboly — mobil BARU akan gagal dibuat. Pilih dari daftar, atau:
                    <span style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <a className="warn-btn" href={`${TURBOLY_URL}/vehicle_models/new`} target="_blank" rel="noreferrer">➕ Tambah Model di Turboly</a>
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="fld"><label>No. Polisi</label>
              <div>
                <input value={noPol} onChange={(e) => setNoPol(e.target.value.toUpperCase())} placeholder="B 1234 XYZ" style={plateBad ? { borderColor: '#d97706' } : undefined} />
                {plateBad && <div className="warn-inline">⚠ Format tidak wajar (contoh: B 1234 XYZ) — boleh lanjut.</div>}
                {ownerMismatch && plateOwner && <div className="warn-inline">⚠ Plat milik <b>{plateOwner.nama}</b> ({plateOwner.wa}) — order tetap atas nama pemilik asli; orang di form dicatat sebagai pembawa.</div>}
                {returning && <div className="ok-inline">↩ Pelanggan lama: {returning} — data terisi otomatis.</div>}
              </div>
            </div>
            <div className="fld"><label>Tahun/Warna</label>
              <div>
                <div style={{ display: 'flex', gap: 4 }}><input value={tahun} onChange={(e) => setTahun(e.target.value)} inputMode="numeric" placeholder="2019" style={tahunWarn ? { borderColor: '#d97706' } : undefined} /><input value={warna} onChange={(e) => setWarna(e.target.value)} placeholder="Warna" /></div>
                {tahunWarn && <div className="warn-inline">⚠ {tahunWarn} — boleh lanjut.</div>}
              </div>
            </div>
            <div className="fld"><label>KM</label>
              <div>
                <input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" placeholder="45.230" style={kmWarn || kmBelowPrev ? { borderColor: '#d97706' } : undefined} />
                {kmWarn && <div className="warn-inline">⚠ {kmWarn} — boleh lanjut.</div>}
                {!kmWarn && kmBelowPrev && <div className="warn-inline">⚠ KM LEBIH KECIL dari kunjungan sebelumnya ({Number(prevVisitKm).toLocaleString('id-ID')}) — boleh lanjut.</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Keluhan */}
        <div className="box" style={{ marginTop: 8 }}>
          <span className="sec-h">KELUHAN</span>
          <input value={keluhan} onChange={(e) => setKeluhan(e.target.value)} />
        </div>

        {/* Pekerjaan + diagram */}
        <div className="mid">
          <div>
            <table className="pk">
              <thead>
                <tr><th className="col-num" style={{ width: 18 }}>#</th><th>PEKERJAAN</th><th style={{ width: 42 }}>ORDER</th><th>KETERANGAN</th><th className="col-mk" style={{ width: 40 }}>MK</th><th className="col-waktu" style={{ width: 44 }}>WAKTU</th></tr>
              </thead>
              <tbody>
                {SERVICES.map((s, i) => {
                  const r = pk[s.code]!;
                  return (
                    <tr key={s.code} className={r.order ? 'row-on' : ''}>
                      <td className="col-num" style={{ textAlign: 'center' }}>{i + 1}</td>
                      <td className="svc" onClick={() => setRow(s.code, { order: !r.order })}>
                        {s.label.toUpperCase()}
                        {s.tag && <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, border: '1px solid currentColor', borderRadius: 3, padding: '0 3px' }}>{s.tag}</span>}
                      </td>
                      <td className="tick-cell" style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <span className={`tick ${r.order ? 'on' : ''}`} onClick={() => setRow(s.code, { order: !r.order })}>{r.order ? '✓' : '▢'}</span>
                        {/* Units come off the printed sheet: a tick row is just a
                            tick; pcs/liter rows order a COUNT, so only they get
                            the number box ("# PCS", "# liter" on paper). */}
                        {r.order && s.unit !== 'check' && (
                          <>
                            <input type="number" min={1} value={r.qty} onChange={(e) => { const v = e.target.value; setRow(s.code, { qty: v === '' ? '' : Math.max(1, Math.floor(Number(v)) || 1) }); }} onBlur={() => { if (pk[s.code]!.qty === '') setRow(s.code, { qty: 1 }); }} className="qty" style={{ width: 26, padding: 0, textAlign: 'center', display: 'inline-block' }} />
                            <span style={{ fontSize: 8 }}>{s.unit === 'pcs' ? 'pcs' : 'ltr'}</span>
                          </>
                        )}
                      </td>
                      <td className="ket-cell">
                        {r.order && svcOpts[s.code]?.options?.length ? (
                          <select value={r.sku || svcOpts[s.code]!.defaultSku} onChange={(e) => setRow(s.code, { sku: e.target.value })} style={{ width: '100%', marginBottom: 3, fontSize: 11 }}>
                            {svcOpts[s.code]!.options.map((o) => <option key={o.sku} value={o.sku}>{o.label}</option>)}
                          </select>
                        ) : null}
                        {r.order && <input type="text" value={r.keterangan} onChange={(e) => setRow(s.code, { keterangan: e.target.value })} placeholder={s.brandType ? 'merk / tipe — contoh: Castrol Edge 5W-30' : 'keterangan'} />}
                        {!r.order && <input className="ket-idle" type="text" value={r.keterangan} onChange={(e) => setRow(s.code, { keterangan: e.target.value })} placeholder="keterangan" />}
                      </td>
                      <td className="col-mk"><input type="text" value={r.mk} onChange={(e) => setRow(s.code, { mk: e.target.value })} /></td>
                      <td className="col-waktu"><input type="text" value={r.waktu} onChange={(e) => setRow(s.code, { waktu: e.target.value })} /></td>
                    </tr>
                  );
                })}
                <tr><td className="col-num" style={{ textAlign: 'center' }}>{SERVICES.length + 1}</td><td className="svc"><input list="jasa-all-sheet" value={extra1} onChange={(e) => setExtra1(e.target.value)} placeholder="Pekerjaan lain — tulis / pilih…" /></td><td className="tick-cell" /><td className="ket-cell" /><td className="col-mk" /><td className="col-waktu" /></tr>
                <tr><td className="col-num" style={{ textAlign: 'center' }}>{SERVICES.length + 2}</td><td className="svc"><input list="jasa-all-sheet" value={extra2} onChange={(e) => setExtra2(e.target.value)} placeholder="Pekerjaan lain — tulis / pilih…" /></td><td className="tick-cell" /><td className="ket-cell" /><td className="col-mk" /><td className="col-waktu" /></tr>
                <datalist id="jasa-all-sheet">{[...new Set(Object.values(svcOpts).flatMap((o) => o.options.map((x) => x.label)))].map((l) => <option key={l} value={l} />)}</datalist>
              </tbody>
            </table>
          </div>
          <div>
            <div className="box" style={{ height: '100%' }}>
              <div style={{ fontSize: 9, fontWeight: 700, marginBottom: 2 }}>
                Pengecekan bodi — ✏ gambar kerusakan langsung
                {dmgInked && <button type="button" className="chk-chip" style={{ marginLeft: 6 }} onClick={() => { dmgInk.current?.clear(); }}>✕ Hapus</button>}
              </div>
              <div style={{ position: 'relative' }}>
                <CarDiagram />
                <DiagramInk ref={dmgInk} active onInk={setDmgInked} />
              </div>
              <div className="fld" style={{ marginTop: 4 }}><label style={{ fontSize: 10 }}>Estimasi (menit)</label><input value={estimasi} onChange={(e) => setEstimasi(e.target.value)} inputMode="numeric" /></div>
            </div>
          </div>
        </div>

        {/* Pengecekan awal */}
        <div style={{ marginTop: 8 }}>
          <FuelGauge mode={fuelMode} pct={fuelPct} ev={evPct} onMode={setFuelMode} onPct={setFuelPct} onEv={setEvPct} />
        <span className="sec-h" style={{ marginTop: 8 }}>PENGECEKAN AWAL KENDARAAN</span>
          <table className="cond">
            <tbody>
              {CONDITION_ITEMS.map((c, i) => (
                <tr key={c.code}>
                  <td style={{ width: 18, textAlign: 'center' }}>{i + 1}</td>
                  <td style={{ width: 130, fontWeight: 600 }}>{c.label}</td>
                  <td>
                    <span className={`opt ${(cond[c.code] ?? []).length === 0 ? 'on' : ''}`} onClick={() => setCond((s) => ({ ...s, [c.code]: [] }))}>OK</span>
                    {c.marks.map((m) => (
                      <span
                        key={m}
                        className={`opt ${(cond[c.code] ?? []).includes(m) ? 'on' : ''}`}
                        style={{ marginLeft: 6 }}
                        onClick={() => setCond((s) => {
                          const cur = s[c.code] ?? [];
                          return { ...s, [c.code]: cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m] };
                        })}
                      >{m}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Authorization + signatures */}
        <div className="auth">
          Saya yang bertanda tangan dibawah ini memberi wewenang penuh kepada bengkel NAWILIS untuk melakukan pekerjaan sesuai dengan permintaan order di atas dan test jalan apabila diperlukan.
        </div>
        <div className="sign">
          <div className="b">Yang menyerahkan,
            <div style={{ height: 56, border: '1px dashed #9fb2d4', borderRadius: 6, display: 'grid', placeItems: 'center', color: '#8a99b8', fontSize: 11, margin: '4px 0' }}>tanda tangan di formulir cetak</div>
            <input value={menyerahkan} onChange={(e) => setMenyerahkan(e.target.value)} placeholder="Nama jelas — WAJIB" style={!menyerahkan.trim() ? { borderColor: '#dc2626' } : undefined} />
          </div>
          <div className="b">Yang menerima,
            <div style={{ height: 56, border: '1px dashed #9fb2d4', borderRadius: 6, display: 'grid', placeItems: 'center', color: '#8a99b8', fontSize: 11, margin: '4px 0' }}>tanda tangan di formulir cetak</div>
            <input
              list="advisor-list"
              value={menerima}
              onChange={(e) => setMenerima(e.target.value)}
              placeholder={advisors.length ? 'Pilih dari daftar atau ketik nama baru' : (branch ? 'Nama jelas & tanda tangan' : 'Pilih cabang dulu / ketik nama')}
            />
            <datalist id="advisor-list">
              {advisors.map((a) => <option key={a.code} value={a.name} />)}
            </datalist>
            {/* Turboly stars Salesperson too, from its own per-store roster. */}
            {salespersonKnown ? (
              <select value={salesperson} onChange={(e) => setSalesperson(e.target.value)} style={{ marginTop: 4, ...(salesperson.trim() ? {} : { borderColor: '#dc2626' }) }}>
                <option value="">— pilih Salesperson — WAJIB</option>
                {salespeople.map((s) => <option key={s.code} value={s.name}>{s.name}</option>)}
              </select>
            ) : (
              <div className="warn-inline">⚠ Daftar salesperson cabang kosong — order memakai nama advisor.</div>
            )}
            {salespersonKnown && menerima.trim() !== '' && !salespeople.some((s) => s.name.toUpperCase() === menerima.trim().toUpperCase()) && (
              <div className="warn-inline">⚠ {menerima.trim()} tidak terdaftar sebagai Salesperson di cabang ini — pilih orang lain untuk kolom ini.</div>
            )}
            {advisorUnknown && <div className="warn-inline">⚠ Nama tidak ada di daftar advisor cabang ini — boleh lanjut; order Turboly akan memakai advisor terdaftar sebagai fallback.</div>}
          </div>
        </div>
        <div className="two" style={{ marginTop: 6 }}>
          <div className="fld"><label>Kontak Lain</label><input value={kontakLain} onChange={(e) => setKontakLain(e.target.value)} /></div>
          <div className="fld"><label>Rekomendasi Service</label><input value={rekom} onChange={(e) => setRekom(e.target.value)} /></div>
        </div>

        {/* Branch checklist */}
        <div className="branches">
          {BRANCHES.map((b) => (
            <label key={b.code}>
              <input type="radio" name="branch" checked={branch === b.code} onChange={() => setBranch(b.code)} /> {b.name}
            </label>
          ))}
        </div>
        <div className="foot">Pioneering wheel alignment and balancing for more than 50 years</div>
      </div>

      <div className="sheet-actions">
        <button className="btn primary" style={{ flex: 1 }} disabled={submitting} onClick={submit}>
          {submitting ? 'Menyimpan…' : `Simpan SPK (${orderedCount} pekerjaan)`}
        </button>
        <a className="btn ghost" href="/admin">Dashboard</a>
      </div>
      {result && (
        <div className="sheet-actions">
          <div className={`finding ${result.ok ? 'CONFIRM' : 'BLOCK'}`} style={result.ok ? { background: '#e6f4ea', color: '#157a3c', flex: 1 } : { flex: 1 }}>{result.text}</div>
        </div>
      )}

    </div>
  );
}
