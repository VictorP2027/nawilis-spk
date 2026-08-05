'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SignaturePad, type SigHandle } from '../components/SignaturePad';
import {
  BRANCHES,
  CHECKGO_SECTIONS,
  CHECKGO_VERDICTS,
  CHECKGO_ELECTRICAL,
  CHECKGO_TIRE,
  CHECKGO_REKOMENDASI,
  type CheckgoTone,
} from '../../lib/refdata.client';

/**
 * Check & Go intake — a vehicle CHECK service (not a repair). One fixed
 * service line: JAS-NAWJAS-GC "General Check", qty 1, typable price
 * (default Rp 100.000 inc tax). The checklist below is the paper "NAWILIS
 * CHECK and GO REPORT", rendered from lib/refdata.client.ts, and is stored in
 * OUR Mongo so the customer can be told exactly what was checked/found.
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

/** One wheel of section 6. `flags` holds the ticked marks, `choice` the
 *  Kurang/Lebih answer of the one mark that has a sub-choice. */
interface TireAnswer { merk: string; tekanan: string; flags: string[]; choice: Record<string, string> }
const EMPTY_TIRE: TireAnswer = { merk: '', tekanan: '', flags: [], choice: {} };

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_HARGA = 100_000; // General Check default price (inc tax)
const DEFAULT_ESTIMASI = 30; // minutes

/** Same divider the detail rows have always used between checklist blocks. */
const SEC_SEP: CSSProperties = { marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--line, #e6e8ee)' };
const SEC_TITLE: CSSProperties = { fontSize: 14, fontWeight: 700 };
/** Readings/tyre fields are compact: three of them share a row on a tablet. */
const SMALL_INPUT: CSSProperties = { fontSize: 16, padding: '8px 10px' };

/**
 * Selected state on a `btn ghost` is an inline fill (this page's own idiom).
 * The fill carries the SEVERITY rather than one neutral highlight: Pass and
 * Fail must not look alike on a tablet read at arm's length.
 */
const TONE_FILL: Record<CheckgoTone, CSSProperties> = {
  ok: { background: 'var(--ok)', borderColor: 'var(--ok)', color: '#fff' },
  warn: { background: 'var(--warn)', borderColor: 'var(--warn)', color: '#fff' },
  block: { background: 'var(--block)', borderColor: 'var(--block)', color: '#fff' },
};
const fillIf = (on: boolean, tone: CheckgoTone): CSSProperties => (on ? TONE_FILL[tone] : {});

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
  // The paper report. Everything is keyed by the refdata codes and everything
  // is optional — an untouched checklist submits exactly like before.
  const [verdict, setVerdict] = useState<Record<string, string>>({}); // section code → Pass/Fail
  const [reading, setReading] = useState<Record<string, string>>({}); // sub-item code → typed value
  const [electrical, setElectrical] = useState(''); // section 5 option code
  const [tire, setTire] = useState<Record<string, TireAnswer>>({}); // position code → answers
  const [rekom, setRekom] = useState<Record<string, string[]>>({}); // rekomendasi group → picks
  const [lainLain, setLainLain] = useState('');
  const sigCust = useRef<SigHandle>(null);
  const [custSigned, setCustSigned] = useState(false);
  // The receiving advisor's signature. Optional: the customer's is the consent
  // that matters, and making this required would block intake whenever the
  // advisor is away from the tablet.
  const sigAdv = useRef<SigHandle>(null);
  const [advSigned, setAdvSigned] = useState(false);
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

  // Tapping the chosen answer again clears it: a mis-tap on a moving tablet is
  // common, and there is no other way back to "not checked".
  const toggle = (cur: string, next: string) => (cur === next ? '' : next);
  const tireOf = (pos: string): TireAnswer => tire[pos] ?? EMPTY_TIRE;
  const setTireOf = (pos: string, patch: Partial<TireAnswer>) =>
    setTire((p) => ({ ...p, [pos]: { ...(p[pos] ?? EMPTY_TIRE), ...patch } }));
  const toggleTireFlag = (pos: string, flag: string) =>
    setTire((p) => {
      const t = p[pos] ?? EMPTY_TIRE;
      const flags = t.flags.includes(flag) ? t.flags.filter((f) => f !== flag) : [...t.flags, flag];
      return { ...p, [pos]: { ...t, flags } };
    });
  const toggleRekom = (group: string, code: string) =>
    setRekom((p) => {
      const cur = p[group] ?? [];
      return { ...p, [group]: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] };
    });

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
      // The whole sheet goes out as CODES, blanks included: the server is the
      // one place that decides what counts as "filled", so this form and
      // /checkgo/sheet can never disagree about it.
      checkReport: {
        sections: CHECKGO_SECTIONS.map((s) => ({
          code: s.code,
          verdict: verdict[s.code] ?? null,
          readings: s.subItems
            .filter((si) => si.measure)
            .map((si) => ({ code: si.code, value: reading[si.code] ?? '' })),
        })),
        electrical: electrical || null,
        tires: CHECKGO_TIRE.positions.map((p) => {
          const t = tireOf(p.code);
          return {
            position: p.code,
            merk: t.merk,
            tekanan: t.tekanan,
            flags: t.flags.map((f) => ({ code: f, choice: t.choice[f] ?? null })),
          };
        }),
        rekomendasi: CHECKGO_REKOMENDASI.map((g) => ({ code: g.code, picks: rekom[g.code] ?? [] })),
        lainLain: lainLain.trim() || null,
      },
      signatures: {
        menyerahkanPresent: !!sigCust.current?.get(),
        menyerahkanNamaJelas: nama || null,
        menerimaPresent: !!advisor,
        menerimaNamaJelas: advisor || null,
        menyerahkanImage: sigCust.current?.get() ?? null,
        menerimaImage: sigAdv.current?.get() ?? null,
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
    setVerdict({}); setReading({}); setElectrical(''); setTire({}); setRekom({}); setLainLain('');
    sigCust.current?.clear();
    sigAdv.current?.clear();
    setAdvSigned(false);
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
          <div className="label">Check and Go Report (opsional)</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.4 }}>
            Isi seperti lembar kertas — semua boleh dikosongkan. Kosong = satu pemeriksaan umum
            &quot;Check and Go&quot;. Tanggal &amp; pemeriksa diambil dari data di atas.
          </div>

          {/* Sections 1-4: one Pass/Fail for the whole section + its readings. */}
          {CHECKGO_SECTIONS.map((s) => (
            <div key={s.code} style={SEC_SEP}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ ...SEC_TITLE, flex: '1 1 160px' }}>{s.no}. {s.title}</span>
                {CHECKGO_VERDICTS.map((v) => (
                  <button
                    key={v.value}
                    type="button"
                    className="btn ghost"
                    style={{ flex: '0 0 auto', fontSize: 13, padding: '8px 16px', ...fillIf(verdict[s.code] === v.value, v.tone) }}
                    onClick={() => setVerdict((p) => ({ ...p, [s.code]: toggle(p[s.code] ?? '', v.value) }))}
                  >
                    {v.value}
                  </button>
                ))}
              </div>
              {s.subItems.map((si) =>
                si.measure ? (
                  <div key={si.code} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <span className="chk-label" style={{ flex: '1 1 150px' }}>
                      {si.label} ({si.measure.hint})
                    </span>
                    <input
                      value={reading[si.code] ?? ''}
                      onChange={(e) => setReading((p) => ({ ...p, [si.code]: e.target.value }))}
                      // Coolant is read as a NEGATIVE number and the iOS numeric
                      // pad has no minus key, so only "%" gets the number pad.
                      inputMode={si.measure.unit === '%' ? 'numeric' : undefined}
                      placeholder={si.measure.unit}
                      style={{ ...SMALL_INPUT, flex: '0 0 96px' }}
                    />
                    <span style={{ flex: '0 0 auto', fontSize: 13, color: 'var(--muted)' }}>{si.measure.unit}</span>
                  </div>
                ) : (
                  <div key={si.code} className="chk-label" style={{ marginTop: 8 }}>{si.label}</div>
                ),
              )}
            </div>
          ))}

          {/* Section 5 — three-way, not a verdict. */}
          <div style={SEC_SEP}>
            <div style={SEC_TITLE}>{CHECKGO_ELECTRICAL.no}. {CHECKGO_ELECTRICAL.title}</div>
            <span style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {CHECKGO_ELECTRICAL.options.map((o) => (
                <button
                  key={o.code}
                  type="button"
                  className="btn ghost"
                  style={{ flex: 1, fontSize: 12.5, padding: '8px 4px', ...fillIf(electrical === o.code, o.tone) }}
                  onClick={() => setElectrical((cur) => toggle(cur, o.code))}
                >
                  {o.label}
                </button>
              ))}
            </span>
          </div>

          {/* Section 6 — four wheels, each with its own marks. */}
          <div style={SEC_SEP}>
            <div style={{ ...SEC_TITLE, marginBottom: 8 }}>{CHECKGO_TIRE.no}. {CHECKGO_TIRE.title}</div>
            {CHECKGO_TIRE.positions.map((pos) => {
              const t = tireOf(pos.code);
              return (
                <div key={pos.code} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{pos.label}</div>
                  <div className="row">
                    <input value={t.merk} onChange={(e) => setTireOf(pos.code, { merk: e.target.value })} placeholder="Merk & Jenis Ban" style={SMALL_INPUT} />
                    <input value={t.tekanan} onChange={(e) => setTireOf(pos.code, { tekanan: e.target.value })} inputMode="numeric" placeholder="Tekanan Angin" style={SMALL_INPUT} />
                  </div>
                  <div className="chk-row" style={{ marginTop: 6 }}>
                    {CHECKGO_TIRE.flags.map((f) => {
                      const on = t.flags.includes(f.code);
                      return (
                        <span key={f.code} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button type="button" className={`chk-chip${on ? ' bad' : ''}`} onClick={() => toggleTireFlag(pos.code, f.code)}>
                            {on ? '✓ ' : ''}{f.label}
                          </button>
                          {/* Kurang/Lebih only matters once the mark is ticked. */}
                          {on && f.choices?.map((c) => (
                            <button
                              key={c}
                              type="button"
                              className={`chk-chip${t.choice[f.code] === c ? ' bad' : ''}`}
                              onClick={() => setTireOf(pos.code, { choice: { ...t.choice, [f.code]: toggle(t.choice[f.code] ?? '', c) } })}
                            >
                              {c}
                            </button>
                          ))}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* The two printed recommendation lists — same tiles as the job picker. */}
          {CHECKGO_REKOMENDASI.map((g) => (
            <div key={g.code} style={{ marginBottom: 12 }}>
              <div className="label">{g.title}</div>
              <div className="tiles">
                {g.options.map((o) => {
                  const on = (rekom[g.code] ?? []).includes(o.code);
                  return (
                    <button key={o.code} type="button" className={`tile${on ? ' on' : ''}`} onClick={() => toggleRekom(g.code, o.code)}>
                      {on ? '✓ ' : ''}{o.label}
                    </button>
                  );
                })}
              </div>
              {g.freeTextLabel && (
                <input style={{ ...SMALL_INPUT, marginTop: 6 }} value={lainLain} onChange={(e) => setLainLain(e.target.value)} placeholder={g.freeTextLabel} />
              )}
            </div>
          ))}
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

          <div className="label" style={{ marginTop: 14 }}>
            Tanda tangan yang menerima{advisor ? ` — ${advisor}` : ' (Service Advisor)'} — opsional
          </div>
          <SignaturePad ref={sigAdv} onInk={setAdvSigned} />
          {!advSigned && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Boleh dikosongkan — nama penerima tetap tercatat.</div>}
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
