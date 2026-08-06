'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SignaturePad, type SigHandle } from '../components/SignaturePad';
import { ProductInput } from '../../lib/productSuggest';
import {
  BRANCHES,
  CHECKGO_SECTIONS,
  CHECKGO_TIRE,
  type CheckgoVerdictOpt,
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

/** One wheel of section 8. `tekanan` is the Lebih/Cukup/Kurang CODE (or ''),
 *  `flags` holds the ticked damage-mark codes. */
interface TireAnswer { merkUkuran: string; tekanan: string; flags: string[] }
const EMPTY_TIRE: TireAnswer = { merkUkuran: '', tekanan: '', flags: [] };

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_HARGA = 100_000; // General Check default price (inc tax)
const DEFAULT_ESTIMASI = 30; // minutes

/** Same divider the detail rows have always used between checklist blocks. */
const SEC_SEP: CSSProperties = { marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid var(--line, #e6e8ee)', scrollMarginTop: 48 };
const SEC_TITLE: CSSProperties = { fontSize: 14, fontWeight: 700 };
/** Readings/tyre fields are compact: three of them share a row on a tablet. */
const SMALL_INPUT: CSSProperties = { fontSize: 16, padding: '4px 8px' };

/**
 * Selected state on a `btn ghost` is an inline fill (this page's own idiom).
 * The fill carries the SEVERITY rather than one neutral highlight: the healthy
 * answer and the needs-attention one must not look alike on a tablet read at
 * arm's length. In every refdata verdict pair the FIRST option is the healthy
 * one (tyre pressure marks its own via `healthy`).
 */
const TONE_FILL: Record<'ok' | 'warn', CSSProperties> = {
  ok: { background: 'var(--ok)', borderColor: 'var(--ok)', color: '#fff' },
  warn: { background: 'var(--warn)', borderColor: 'var(--warn)', color: '#fff' },
};
const fillIf = (on: boolean, healthy: boolean): CSSProperties => (on ? TONE_FILL[healthy ? 'ok' : 'warn'] : {});
/** The segmented-button look shared by every verdict pair on the sheet. */
const VERDICT_BTN: CSSProperties = { flex: '0 0 auto', fontSize: 13, padding: '4px 10px' };

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
  // The customer's email — the final-3 sheet header asks for it. Optional;
  // travels as customer.kontakLain ("Email: …") because that is the one free
  // contact slot SpkIntakeInput has.
  const [email, setEmail] = useState('');
  // The paper report (final 3). Everything is keyed by the refdata codes and
  // everything is optional — an untouched sheet submits exactly like before.
  const [secVerdict, setSecVerdict] = useState<Record<string, string>>({}); // section code → its verdict code
  const [itemVerdict, setItemVerdict] = useState<Record<string, string>>({}); // item code → its verdict code
  const [reading, setReading] = useState<Record<string, string>>({}); // `${item}.${reading}` → typed value
  const [secRekom, setSecRekom] = useState<Record<string, string[]>>({}); // section code → rekomendasi picks
  const [rekomLain, setRekomLain] = useState<Record<string, string>>({}); // section code → freeText detail
  const [extraParts, setExtraParts] = useState<string[]>([]); // LAIN "Part suspensi" lines, by index
  const [tire, setTire] = useState<Record<string, TireAnswer>>({}); // position code → answers
  const [tireRekom, setTireRekom] = useState<string[]>([]); // tire rekomendasi picks
  const [tireLain, setTireLain] = useState<string[]>([]); // the 3 blank tire lines, by index
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
  const toggleIn = (list: string[], code: string) =>
    list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
  const tireOf = (pos: string): TireAnswer => tire[pos] ?? EMPTY_TIRE;
  const setTireOf = (pos: string, patch: Partial<TireAnswer>) =>
    setTire((p) => ({ ...p, [pos]: { ...(p[pos] ?? EMPTY_TIRE), ...patch } }));
  const toggleTireFlag = (pos: string, flag: string) =>
    setTire((p) => {
      const t = p[pos] ?? EMPTY_TIRE;
      return { ...p, [pos]: { ...t, flags: toggleIn(t.flags, flag) } };
    });
  const toggleSecRekom = (sec: string, code: string) =>
    setSecRekom((p) => ({ ...p, [sec]: toggleIn(p[sec] ?? [], code) }));
  const setLine = (set: typeof setExtraParts, i: number, v: string) =>
    set((p) => { const n = [...p]; n[i] = v; return n; });

  /** One verdict pair rendered as segmented buttons — first option is healthy. */
  // ── one-tap section flow ─────────────────────────────────────────────────
  // On a real check almost every row is healthy and the checker's time goes to
  // the exceptions. "Semua baik" fills a section's every verdict with its
  // healthy first option in one tap; individual rows can still be flipped
  // afterwards, and tapping it again clears the whole section (honest toggle).
  type Sec = (typeof CHECKGO_SECTIONS)[number];
  // The report is OPTIONAL and long; it starts folded so the required intake
  // fields read as one screen. The header always says how much is inside.
  const [reportOpen, setReportOpen] = useState(true);
  const sectionSlots = (s: Sec) => (s.verdicts ? 1 : 0) + s.items.filter((it) => it.verdicts).length;
  const sectionDone = (s: Sec) =>
    (s.verdicts && secVerdict[s.code] ? 1 : 0) + s.items.filter((it) => it.verdicts && itemVerdict[it.code]).length;
  const sectionAllHealthy = (s: Sec) =>
    (!s.verdicts || secVerdict[s.code] === s.verdicts[0]!.code) &&
    s.items.every((it) => !it.verdicts || itemVerdict[it.code] === it.verdicts[0]!.code);
  const markAllHealthy = (s: Sec) => {
    const clear = sectionAllHealthy(s);
    if (s.verdicts) setSecVerdict((p) => ({ ...p, [s.code]: clear ? '' : s.verdicts![0]!.code }));
    setItemVerdict((p) => {
      const n = { ...p };
      for (const it of s.items) if (it.verdicts) n[it.code] = clear ? '' : it.verdicts[0]!.code;
      return n;
    });
  };

  const verdictButtons = (
    opts: ReadonlyArray<CheckgoVerdictOpt>,
    cur: string,
    pick: (code: string) => void,
  ) =>
    opts.map((v, i) => (
      <button
        key={v.code}
        type="button"
        className="btn ghost"
        style={{ ...VERDICT_BTN, ...fillIf(cur === v.code, i === 0) }}
        onClick={() => pick(toggle(cur, v.code))}
      >
        {v.label}
      </button>
    ));

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

  const emailOk = /\S+@\S+\.\S+/.test(email.trim());
  // A branch whose mechanic list failed to load must not be locked out — but
  // when the list is there, the check has to name who performed it.
  const mekanikOk = mekanikList.length === 0 || mekanik !== '';
  // The report IS the product being sold: every section answered, every wheel's
  // pressure recorded. "Semua baik" makes the healthy car eight taps.
  const reportOk =
    CHECKGO_SECTIONS.every((s2) => sectionSlots(s2) === 0 || sectionDone(s2) === sectionSlots(s2)) &&
    CHECKGO_TIRE.positions.every((p2) => (tire[p2.code]?.tekanan ?? '') !== '');
  const canSubmit = !!branch && waOk && namaOk && alamatOk && plateOk && merkOk && tipeOk && tahunOk && warnaOk && kmOk && advisorOk && hargaOk && estimasiOk && emailOk && mekanikOk && reportOk && custSigned && advSigned && !submitting;

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
      customer: {
        nama,
        wa: wa || null,
        alamat: alamat || null,
        kontakLain: email.trim() ? `Email: ${email.trim()}` : null,
      },
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
          verdict: secVerdict[s.code] || null,
          items: s.items.map((it) => ({
            code: it.code,
            verdict: itemVerdict[it.code] || null,
            readings: (it.readings ?? []).map((r) => ({ code: r.code, value: reading[`${it.code}.${r.code}`] ?? '' })),
          })),
          rekomendasi: secRekom[s.code] ?? [],
          rekomendasiLain: rekomLain[s.code] || null,
          extraParts: s.extraList
            ? Array.from({ length: s.extraList.count }, (_, i) => extraParts[i] ?? '')
            : [],
        })),
        tires: CHECKGO_TIRE.positions.map((p) => {
          const t = tireOf(p.code);
          return { position: p.code, merkUkuran: t.merkUkuran || null, tekanan: t.tekanan || null, flags: t.flags };
        }),
        tireRekomendasi: {
          picks: tireRekom,
          lain: Array.from({ length: CHECKGO_TIRE.freeLines }, (_, i) => tireLain[i] ?? ''),
        },
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
    setWa(''); setNama(''); setAlamat(''); setEmail('');
    setPlate(''); setMerk(''); setTipe(''); setTahun(''); setWarna(''); setKm('');
    setHist(null); setPlateOwner(null); setCustVehicles([]); setCustHint(null); setRegName(null);
    setHarga(String(DEFAULT_HARGA));
    setEstimasi(String(DEFAULT_ESTIMASI));
    setSecVerdict({}); setItemVerdict({}); setReading({});
    setSecRekom({}); setRekomLain({}); setExtraParts([]);
    setTire({}); setTireRekom([]); setTireLain([]);
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
              <select value={mekanik} onChange={(e) => setMekanik(e.target.value)} style={!mekanikOk ? { borderColor: '#dc2626' } : undefined}>
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
          {(() => {
            const full =
              CHECKGO_SECTIONS.filter((s2) => sectionSlots(s2) > 0 && sectionDone(s2) === sectionSlots(s2)).length +
              (CHECKGO_TIRE.positions.every((p2) => (tire[p2.code]?.tekanan ?? '') !== '') ? 1 : 0);
            return (
              <button
                type="button"
                onClick={() => setReportOpen((o) => !o)}
                style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <span className="label" style={{ marginBottom: 0 }}>Check and Go Report — WAJIB</span>
                <span style={{ fontSize: 12.5, color: reportOk ? '#15803d' : 'var(--block, #dc2626)', fontWeight: 700 }}>
                  {reportOk ? '✓ lengkap' : `${full}/8 — belum lengkap`} {reportOpen ? '▲' : '▼'}
                </span>
              </button>
            );
          })()}
          {reportOpen && (<>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 0 10px', lineHeight: 1.4 }}>
            Semua bagian wajib dijawab — &quot;Semua baik&quot; mengisi satu bagian sehat dengan satu
            ketuk. Tanggal &amp; pemeriksa diambil dari data di atas.
          </div>
          {!reportOk && (
            <div className="req-note" style={{ marginBottom: 8 }}>
              ⚠ belum lengkap: {[
                ...CHECKGO_SECTIONS.filter((s2) => sectionSlots(s2) > 0 && sectionDone(s2) < sectionSlots(s2)).map((s2) => `${s2.no}. ${s2.title}`),
                ...(CHECKGO_TIRE.positions.some((p2) => (tire[p2.code]?.tekanan ?? '') === '') ? [`${CHECKGO_TIRE.no}. Tekanan ban (semua roda)`] : []),
              ].join(' · ')}
            </div>
          )}

          {/* Sticky one-tap navigation across the 8 printed sections. A chip
              turns green when its section is fully answered. */}
          <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#fff', display: 'flex', gap: 4, padding: '6px 0', marginBottom: 4, flexWrap: 'wrap' }}>
            {[
              ...CHECKGO_SECTIONS.map((s) => ({ no: s.no, full: sectionSlots(s) > 0 && sectionDone(s) === sectionSlots(s) })),
              { no: CHECKGO_TIRE.no, full: CHECKGO_TIRE.positions.every((p) => (tire[p.code]?.tekanan ?? '') !== '') },
            ].map((c) => (
              <button
                key={c.no}
                type="button"
                className="chk-chip"
                style={{ minWidth: 34, justifyContent: 'center', ...(c.full ? { background: '#dcfce7', borderColor: '#15803d', color: '#15803d', fontWeight: 700 } : {}) }}
                onClick={() => document.getElementById(`cg-sec-${c.no}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                {c.full ? '✓' : ''}{c.no}
              </button>
            ))}
          </div>

          {/* Sections 1-7: per-row verdict pairs + readings, each section with
              its own recommendation checklist right under it (the printed layout). */}
          {CHECKGO_SECTIONS.map((s) => (
            <div key={s.code} id={`cg-sec-${s.no}`} style={SEC_SEP}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ ...SEC_TITLE, flex: '1 1 auto' }}>
                  {s.no}. {s.title}{' '}
                  {sectionDone(s) > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: sectionDone(s) === sectionSlots(s) ? '#15803d' : 'var(--muted)' }}>
                      {sectionDone(s)}/{sectionSlots(s)}
                    </span>
                  )}
                </span>
                {s.verdicts &&
                  verdictButtons(s.verdicts, secVerdict[s.code] ?? '', (code) =>
                    setSecVerdict((p) => ({ ...p, [s.code]: code })),
                  )}
                <button
                  type="button"
                  className={`chk-chip${sectionAllHealthy(s) ? ' ok' : ''}`}
                  onClick={() => markAllHealthy(s)}
                  title="Satu ketuk: semua jawaban bagian ini sehat. Ketuk lagi untuk kosongkan."
                >
                  {sectionAllHealthy(s) ? '✓ ' : ''}Semua baik
                </button>
              </div>
              {/* ONE row per item: label · readings · verdict. The reading's
                  label lives in its placeholder — a separate caption per input
                  doubled every row's height for words the box already says. */}
              {s.items.map((it) => (
                <div key={it.code} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
                  <span className="chk-label" style={{ flex: '0 1 auto', fontSize: 12.5, minWidth: 130 }}>{it.label}</span>
                  {it.readings?.map((r) => {
                    const key = `${it.code}.${r.code}`;
                    return (
                      <span key={r.code} style={{ display: 'flex', alignItems: 'center', gap: 3, flex: '0 1 auto' }}>
                        {r.code === 'MERK_SAE' ? (
                          // The oil box gets the tenant's real OLM catalog as
                          // typeahead — 252 oils, picked or free-typed.
                          <ProductInput
                            cat="OLM"
                            value={reading[key] ?? ''}
                            onChange={(v) => setReading((p) => ({ ...p, [key]: v }))}
                            placeholder={r.label}
                            style={{ ...SMALL_INPUT, width: 170 }}
                          />
                        ) : (
                          <input
                            value={reading[key] ?? ''}
                            onChange={(e) => setReading((p) => ({ ...p, [key]: e.target.value }))}
                            // Coolant is read as a NEGATIVE number and the iOS numeric
                            // pad has no minus key, so suffixed readings stay free-text.
                            placeholder={r.label}
                            style={{ ...SMALL_INPUT, width: r.code === 'TGL' ? 110 : 90 }}
                          />
                        )}
                        {r.suffix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.suffix}</span>}
                      </span>
                    );
                  })}
                  {it.verdicts && (
                    <span style={{ display: 'flex', gap: 4 }}>
                      {verdictButtons(it.verdicts, itemVerdict[it.code] ?? '', (code) =>
                        setItemVerdict((p) => ({ ...p, [it.code]: code })),
                      )}
                    </span>
                  )}
                </div>
              ))}
              <div className="chk-row" style={{ marginTop: 4 }}>
                <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--muted)' }}>Rekomendasi:</span>
                {s.rekomendasi.map((o) => {
                  const on = (secRekom[s.code] ?? []).includes(o.code);
                  return (
                    <button key={o.code} type="button" className={`chk-chip${on ? ' ok' : ''}`} onClick={() => toggleSecRekom(s.code, o.code)}>
                      {on ? '✓ ' : ''}{o.label}
                    </button>
                  );
                })}
              </div>
              {s.rekomendasi.some((o) => o.freeText && (secRekom[s.code] ?? []).includes(o.code)) && (
                <input
                  style={{ ...SMALL_INPUT, marginTop: 6 }}
                  value={rekomLain[s.code] ?? ''}
                  onChange={(e) => setRekomLain((p) => ({ ...p, [s.code]: e.target.value }))}
                  placeholder="Detail (mis. lampu yang diganti)"
                />
              )}
              {s.extraList && (
                <div style={{ marginTop: 10 }}>
                  <div className="label">{s.extraList.label}</div>
                  {Array.from({ length: s.extraList.count }, (_, i) => (
                    <input
                      key={i}
                      style={{ ...SMALL_INPUT, marginTop: 4 }}
                      value={extraParts[i] ?? ''}
                      onChange={(e) => setLine(setExtraParts, i, e.target.value)}
                      placeholder={`${i + 1}.`}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Section 8 — four wheels, 2-up on anything wider than a phone. */}
          <div id={`cg-sec-${CHECKGO_TIRE.no}`} style={SEC_SEP}>
            <div style={{ ...SEC_TITLE, marginBottom: 6 }}>{CHECKGO_TIRE.no}. {CHECKGO_TIRE.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8 }}>
            {CHECKGO_TIRE.positions.map((pos) => {
              const t = tireOf(pos.code);
              return (
                <div key={pos.code} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{pos.label}</div>
                  {/* 3.3k tires scraped from the tenant behind this box. */}
                  <ProductInput
                    cat="BAN"
                    value={t.merkUkuran}
                    onChange={(v) => setTireOf(pos.code, { merkUkuran: v })}
                    placeholder="Merk & ukuran ban"
                    style={SMALL_INPUT}
                  />
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                    <span style={{ flex: '1 1 90px', fontSize: 12.5, color: 'var(--muted)' }}>Tekanan angin</span>
                    {CHECKGO_TIRE.tekanan.map((o) => (
                      <button
                        key={o.code}
                        type="button"
                        className="btn ghost"
                        style={{ ...VERDICT_BTN, padding: '8px 12px', ...fillIf(t.tekanan === o.code, !!o.healthy) }}
                        onClick={() => setTireOf(pos.code, { tekanan: toggle(t.tekanan, o.code) })}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div className="chk-row" style={{ marginTop: 4 }}>
                    {CHECKGO_TIRE.flags.map((f) => {
                      const on = t.flags.includes(f.code);
                      return (
                        <button key={f.code} type="button" className={`chk-chip${on ? ' bad' : ''}`} onClick={() => toggleTireFlag(pos.code, f.code)}>
                          {on ? '✓ ' : ''}{f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            </div>
            <div className="chk-row" style={{ marginTop: 4 }}>
              <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--muted)' }}>Rekomendasi:</span>
              {CHECKGO_TIRE.rekomendasi.map((o) => {
                const on = tireRekom.includes(o.code);
                return (
                  <button key={o.code} type="button" className={`chk-chip${on ? ' ok' : ''}`} onClick={() => setTireRekom((p) => toggleIn(p, o.code))}>
                    {on ? '✓ ' : ''}{o.label}
                  </button>
                );
              })}
            </div>
            {Array.from({ length: CHECKGO_TIRE.freeLines }, (_, i) => (
              <input
                key={i}
                style={{ ...SMALL_INPUT, marginTop: 4 }}
                value={tireLain[i] ?? ''}
                onChange={(e) => setLine(setTireLain, i, e.target.value)}
                placeholder={`Rekomendasi lain ${i + 1}`}
              />
            ))}
          </div>
          </>)}
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
          <div className="row" style={{ marginTop: 10 }}>
            <input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoCapitalize="none" placeholder="Email — WAJIB" style={!emailOk ? { borderColor: '#dc2626' } : undefined} />
            {!emailOk && <div className="req-note">⚠ wajib — email valid, contoh nama@domain.com</div>}
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
            Tanda tangan yang menerima{advisor ? ` — ${advisor}` : ' (Service Advisor)'} — WAJIB
          </div>
          <SignaturePad ref={sigAdv} onInk={setAdvSigned} />
          {!advSigned && <div className="req-note">⚠ wajib — advisor menandatangani hasil pemeriksaan</div>}
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
