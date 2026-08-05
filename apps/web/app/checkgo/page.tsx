'use client';

import { useEffect, useRef, useState } from 'react';
import { SignaturePad, type SigHandle } from '../components/SignaturePad';
import { BRANCHES } from '../../lib/refdata.client';

/**
 * Check & Go intake — a vehicle CHECK service (not a repair). One fixed
 * service line: JAS-NAWJAS-GC "General Check", qty 1, typable price
 * (default Rp 100.000 inc tax). Optional detailed inspection rows are stored
 * in OUR Mongo so the customer can be told exactly what was checked/found.
 */

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

interface CustVehicle { plate: string; merk: string | null; tipe: string | null; tahun: number | null; warna: string | null }

interface InspRow { id: string; item: string; catatan: string }

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_HARGA = 100_000; // General Check default price (inc tax)
const DEFAULT_ESTIMASI = 30; // minutes

export default function CheckGoIntake() {
  const [branch, setBranch] = useState('');
  const [operator, setOperator] = useState('');
  // The mechanic who does the check. Kept as {code,name}: Turboly rejects a WO
  // line assigned to anyone outside that branch's mechanic list, and its names
  // are not unique, so the store-user code is the only exact answer.
  const [mekanik, setMekanik] = useState('');
  const [mekanikList, setMekanikList] = useState<Array<{ code: string; name: string }>>([]);
  const [mekanikNote, setMekanikNote] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [wa, setWa] = useState('');
  const [nama, setNama] = useState('');
  const [alamat, setAlamat] = useState('');
  const [plate, setPlate] = useState('');
  const [merk, setMerk] = useState('');
  const [tipe, setTipe] = useState('');
  const [tahun, setTahun] = useState('');
  const [warna, setWarna] = useState('');
  const [km, setKm] = useState('');
  const [advisor, setAdvisor] = useState('');
  const [harga, setHarga] = useState(String(DEFAULT_HARGA));
  const [estimasi, setEstimasi] = useState(String(DEFAULT_ESTIMASI));
  const [insp, setInsp] = useState<InspRow[]>([]);
  const sigCust = useRef<SigHandle>(null);
  const [custSigned, setCustSigned] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; token?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [makeKnown, setMakeKnown] = useState(false);
  const [hist, setHist] = useState<VehicleHist | null>(null);
  const [plateOwner, setPlateOwner] = useState<{ nama: string; wa: string | null } | null>(null);
  const [custVehicles, setCustVehicles] = useState<CustVehicle[]>([]);
  const [custHint, setCustHint] = useState<string | null>(null);
  const [regName, setRegName] = useState<string | null>(null);

  // Same device memory as the SPK quick form — one setup per tablet.
  useEffect(() => {
    setBranch(localStorage.getItem('branch') ?? '');
    setOperator(localStorage.getItem('operator') ?? '');
  }, []);
  useEffect(() => { if (branch) localStorage.setItem('branch', branch); }, [branch]);
  useEffect(() => { if (operator) localStorage.setItem('operator', operator); }, [operator]);

  // Mechanics are per branch, so the list is refetched whenever the branch
  // changes and any stale pick is dropped — carrying one across branches would
  // send a mechanic Turboly refuses.
  useEffect(() => {
    if (!branch) { setMekanikList([]); setMekanik(''); setMekanikNote(null); return; }
    let alive = true;
    setMekanik('');
    fetch(`/api/mechanics?branch=${encodeURIComponent(branch)}`)
      .then((r) => r.json())
      .then((o: { mechanics?: Array<{ code?: string; name?: string }>; note?: string }) => {
        if (!alive) return;
        const list = (o.mechanics ?? [])
          .map((m) => ({ code: String(m.code ?? ''), name: String(m.name ?? '') }))
          .filter((m) => m.code && m.name);
        setMekanikList(list);
        setMekanikNote(list.length === 0 ? (o.note ?? 'Daftar mekanik cabang ini kosong') : null);
      })
      .catch(() => { if (alive) { setMekanikList([]); setMekanikNote('Daftar mekanik gagal dimuat'); } });
    return () => { alive = false; };
  }, [branch]);

  useEffect(() => {
    fetch('/api/vehicle-makes').then((r) => r.json()).then((d) => setMakes(d.makes ?? [])).catch(() => {});
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

  // PHONE-FIRST: typing the WA auto-populates the person + car(s); chips switch cars.
  const waDigits = wa.replace(/\D/g, '');
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
            const vs: CustVehicle[] = d.vehicles ?? [];
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

  // Debounced plate → history lookup (returning-customer fast path).
  useEffect(() => {
    const key = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key.length < 4) { setHist(null); setPlateOwner(null); return; }
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
      } catch { /* offline — ignore */ }
    }, 350);
    return () => clearTimeout(t);
  }, [plate]);

  const pickVehicle = (v: CustVehicle) => {
    setPlate(v.plate); setMerk(v.merk ?? ''); setTipe(v.tipe ?? '');
    setTahun(v.tahun ? String(v.tahun) : ''); setWarna(v.warna ?? '');
  };

  const addInsp = () => setInsp((p) => [...p, { id: uuid(), item: '', catatan: '' }]);
  const setInspRow = (id: string, patch: Partial<InspRow>) => setInsp((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const delInsp = (id: string) => setInsp((p) => p.filter((r) => r.id !== id));

  // ENFORCED Indonesian WA format: identity key of the customer.
  const waNat = waDigits.replace(/^62/, '').replace(/^0/, '');
  const waOk = /^8\d{8,11}$/.test(waNat);
  const waE164Preview = waOk ? `+62${waNat}` : null;
  const canonK = (s: string) => s.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
  const ownerMismatch = !!plateOwner?.wa && canonK(wa).length >= 8 && canonK(plateOwner.wa) !== canonK(wa);

  const plateOk = plate.trim() !== '';
  const plateNorm = plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const plateBad = plate.trim() !== '' && !/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(plateNorm);
  const namaOk = nama.trim() !== '';
  const alamatOk = alamat.trim() !== '';
  const merkOk = merk.trim() !== '';
  const tipeOk = tipe.trim() !== '';
  const tahunOk = tahun.trim() !== '';
  const warnaOk = warna.trim() !== '';
  const kmOk = km.trim() !== '';
  const advisorOk = advisor.trim() !== '';
  const hargaVal = Number(harga.replace(/[^\d]/g, ''));
  const hargaOk = Number.isFinite(hargaVal) && hargaVal > 0;
  // Estimasi optional — blank falls back to the 30-minute default.
  const estimasiVal = estimasi.trim() === '' ? DEFAULT_ESTIMASI : Number(estimasi.trim());
  const estimasiOk = Number.isInteger(estimasiVal) && estimasiVal > 0;
  const kmValQ = /\d/.test(km) ? Number(km.replace(/[.\s]/g, '')) : NaN;
  const kmBelowPrev = hist?.lastKm != null && !Number.isNaN(kmValQ) && kmValQ < hist.lastKm;
  const makeUnknown = merk.trim() !== '' && makes.length > 0 && !makes.some((m) => m.toUpperCase() === merk.trim().toUpperCase());
  const modelUnknown = tipe.trim() !== '' && makeKnown && models.length > 0 && !models.some((m) => m.toUpperCase() === tipe.trim().toUpperCase());
  const advisorUnknown = advisor.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === advisor.trim().toUpperCase());

  const canSubmit = !!branch && waOk && namaOk && alamatOk && plateOk && merkOk && tipeOk && tahunOk && warnaOk && kmOk && advisorOk && hargaOk && estimasiOk && custSigned && !submitting;

  async function submit() {
    setSubmitting(true);
    setResult(null);
    const payload = {
      uploadId: uuid(),
      docType: 'CHECK_AND_GO',
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
      complaint: null,
      estimasiMinutes: estimasiVal,
      serviceAdvisorName: advisor || null,
      salespersonName: advisor || null,
      // Carried so the Work Order can be assigned without asking again. Both
      // are sent: the code is what Turboly matches on, the name is what a human
      // reads on the board.
      mechanicCode: mekanik || null,
      mechanicName: mekanikList.find((m) => m.code === mekanik)?.name ?? null,
      harga: hargaVal,
      inspectionItems: insp
        .filter((r) => r.item.trim() !== '')
        .map((r) => ({ item: r.item.trim(), catatan: r.catatan.trim() })),
      signatures: {
        menyerahkanPresent: !!sigCust.current?.get(),
        menyerahkanNamaJelas: nama || null,
        menerimaPresent: !!advisor,
        menerimaNamaJelas: advisor || null,
        menyerahkanImage: sigCust.current?.get() ?? null,
        menerimaImage: null,
      },
    };
    try {
      const res = await fetch('/api/checkgo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const notes = (body.findings ?? []).map((f: { message: string }) => f.message).join('; ');
        if (body.needsReview) {
          setResult({ ok: false, text: `Tersimpan, perlu diperbaiki: ${notes}`, token: body.correlationToken });
        } else {
          setResult({ ok: true, text: `✓ Check & Go tersimpan & dikirim ke Turboly.${notes ? ` (Catatan: ${notes})` : ''}`, token: body.correlationToken });
          resetForm();
        }
      } else {
        setResult({ ok: false, text: body.error ?? 'Gagal menyimpan.' });
      }
    } catch (e) {
      setResult({ ok: false, text: `Gagal menyimpan: ${(e as Error).message}` });
    }
    setSubmitting(false);
  }

  function resetForm() {
    setWa(''); setNama(''); setAlamat('');
    setPlate(''); setMerk(''); setTipe(''); setTahun(''); setWarna(''); setKm('');
    setHist(null); setPlateOwner(null); setCustVehicles([]); setCustHint(null); setRegName(null);
    setHarga(String(DEFAULT_HARGA));
    setEstimasi(String(DEFAULT_ESTIMASI));
    setInsp([]);
    sigCust.current?.clear();
    // Advisor must be a deliberate choice per order — never carried over.
    setAdvisor('');
  }

  return (
    <>
      <div className="topbar">
        <span className="brand">NAWILIS · CHECK &amp; GO</span>
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

            <div className="label" style={{ marginTop: 12 }}>Mekanik yang mengerjakan (opsional)</div>
            {mekanikList.length > 0 ? (
              <select value={mekanik} onChange={(e) => setMekanik(e.target.value)}>
                <option value="">— pilih mekanik —</option>
                {mekanikList.map((m) => (
                  <option key={m.code} value={m.code}>{m.name}</option>
                ))}
              </select>
            ) : (
              <div className="warn-note">⚠ {mekanikNote ?? 'Pilih cabang dulu'} — Work Order nanti diisi mekanik lewat papan alur.</div>
            )}
          </div>
        )}

        <div className="card">
          <div className="label">Nomor WhatsApp — identitas pelanggan (ketik dulu)</div>
          <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="08…" style={!waOk ? { borderColor: '#dc2626' } : undefined} />
          {!waOk && <div className="req-note">⚠ wajib — format Indonesia 08… / +62 8…, contoh 08123456789</div>}
          {waOk && <div className="ok-sm">✓ {waE164Preview}{custHint ? ` · ↩ ${custHint}` : ''}{custVehicles.length > 1 ? ' — pilih mobil:' : ''}</div>}
          {custVehicles.length > 1 && (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {custVehicles.map((v) => (
                <button key={v.plate} type="button" className="btn ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => pickVehicle(v)}>
                  {v.plate}{v.merk ? ` · ${v.merk}` : ''}
                </button>
              ))}
            </span>
          )}
        </div>

        <div className="card">
          <div className="label">No. Polisi</div>
          <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="B 1234 SZA — WAJIB" autoCapitalize="characters" style={!plateOk ? { borderColor: '#dc2626' } : plateBad ? { borderColor: '#d97706' } : undefined} />
          {!plateOk && <div className="req-note">⚠ wajib diisi</div>}
          {plateBad && <div className="warn-note">⚠ Format tidak wajar (contoh: B 1234 XYZ) — boleh lanjut.</div>}
          {ownerMismatch && plateOwner && (
            <div className="warn-note">⚠ Plat ini milik <b>{plateOwner.nama}</b> ({plateOwner.wa}) — WA berbeda. Order Turboly <b>tetap atas nama {plateOwner.nama}</b>; orang di form ini dicatat sebagai pembawa kendaraan.</div>
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
          <div className="row" style={{ marginTop: 10 }}>
            <div>
              <div className="label">Merk</div>
              <input list="make-list-cg" value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="Toyota — WAJIB" style={!merkOk ? { borderColor: '#dc2626' } : makeUnknown ? { borderColor: '#d97706' } : undefined} />
              {!merkOk && <div className="req-note">⚠ wajib diisi</div>}
              <datalist id="make-list-cg">{makes.map((m) => <option key={m} value={m} />)}</datalist>
              {makeUnknown && <div className="warn-note">⚠ Merk tidak ada di katalog Turboly — boleh lanjut.</div>}
            </div>
            <div>
              <div className="label">Tipe</div>
              <input list="model-list-cg" value={tipe} onChange={(e) => setTipe(e.target.value)} placeholder="Avanza — WAJIB" style={!tipeOk ? { borderColor: '#dc2626' } : modelUnknown ? { borderColor: '#d97706' } : undefined} />
              {!tipeOk && <div className="req-note">⚠ wajib diisi</div>}
              <datalist id="model-list-cg">{models.map((m) => <option key={m} value={m} />)}</datalist>
              {modelUnknown && <div className="warn-note">⚠ Tipe tidak ada di daftar {merk.trim().toUpperCase()} — dipetakan ke model paling mirip saat kirim.</div>}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="label">Pekerjaan — General Check</div>
          <div className="tiles" style={{ gridTemplateColumns: '1fr' }}>
            <div className="tile on" style={{ cursor: 'default' }}>
              General Check (JAS-NAWJAS-GC) · 1×
              <input
                className="price"
                value={harga}
                onChange={(e) => setHarga(e.target.value)}
                inputMode="numeric"
                placeholder="harga (Rp)"
                style={!hargaOk ? { borderColor: '#dc2626' } : undefined}
              />
            </div>
          </div>
          {!hargaOk && <div className="req-note">⚠ harga wajib — angka Rupiah, contoh 100000</div>}
          {hargaOk && <div className="ok-sm">✓ Rp {hargaVal.toLocaleString('id-ID')} (termasuk pajak)</div>}
          <div className="label" style={{ marginTop: 12 }}>Estimasi waktu (menit) — opsional, default 30</div>
          <input value={estimasi} onChange={(e) => setEstimasi(e.target.value)} inputMode="numeric" placeholder="30" style={!estimasiOk ? { borderColor: '#dc2626', maxWidth: 140 } : { maxWidth: 140 }} />
          {!estimasiOk && <div className="req-note">⚠ angka menit, contoh 30 — kosongkan untuk default</div>}
        </div>

        <div className="card">
          <div className="label">Pemeriksaan detail (opsional)</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.4 }}>
            Kosong = satu pemeriksaan umum &quot;Check and Go&quot;. Tambah baris untuk item spesifik
            (mis. sistem pendingin, tutup radiator) — hasilnya dicatat agar bisa dijelaskan ke customer.
          </div>
          {insp.map((r, i) => (
            <div key={r.id} className="row" style={{ marginBottom: 6 }}>
              <input value={r.item} onChange={(e) => setInspRow(r.id, { item: e.target.value })} placeholder={`Item ${i + 1} — mis. Sistem pendingin`} />
              <input value={r.catatan} onChange={(e) => setInspRow(r.id, { catatan: e.target.value })} placeholder="Catatan (opsional)" />
              <button type="button" className="btn ghost" style={{ flex: '0 0 auto', fontSize: 14, padding: '10px 14px', color: '#b3261e' }} onClick={() => delInsp(r.id)} title="Hapus baris">✕</button>
            </div>
          ))}
          <button type="button" className="btn ghost" style={{ width: '100%', fontSize: 14 }} onClick={addInsp}>+ Tambah item pemeriksaan</button>
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
          <input list="advisor-list-cg" value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder={advisors.length ? 'Pilih dari daftar / ketik' : 'Nama advisor'} style={!advisorOk ? { borderColor: '#dc2626' } : advisorUnknown ? { borderColor: '#d97706' } : undefined} />
          <datalist id="advisor-list-cg">{advisors.map((a) => <option key={a.code} value={a.name} />)}</datalist>
          {!advisorOk && <div className="req-note">⚠ wajib — Turboly menolak order tanpa advisor</div>}
          {advisorUnknown && <div className="warn-note">⚠ Tidak ada di daftar advisor cabang — harus sama persis dengan nama di Turboly, atau order gagal.</div>}
        </div>

        <div className="card">
          <div className="label">Tanda tangan customer — WAJIB (persetujuan pengecekan)</div>
          <SignaturePad ref={sigCust} onInk={setCustSigned} />
          {!custSigned && <div className="req-note">⚠ tanda tangan customer wajib</div>}
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
          {submitting ? 'Menyimpan…' : `Simpan Check & Go — Rp ${(hargaOk ? hargaVal : 0).toLocaleString('id-ID')}`}
        </button>

        <div className="sync" style={{ marginTop: 12, textAlign: 'center', color: 'var(--muted)' }}>
          <a href="/checkgo/sheet">Form Check &amp; Go (lembar)</a>
          {' · '}
          <a href="/">Form SPK</a>
          {' · '}
          <a href="/admin">Dashboard</a>
        </div>
      </div>
    </>
  );
}
