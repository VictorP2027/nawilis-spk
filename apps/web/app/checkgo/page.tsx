'use client';

import BrandMark from './../components/BrandMark';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { ProductInput } from '../../lib/productSuggest';
import { submitOrQueue, flush } from '../../lib/outbox';
import {
  BRANCHES,
  CHECKGO_SECTIONS,
  CHECKGO_TIRE,
  REKOMENDASI_SERVICE,
  SERVICES,
  type CheckgoVerdictOpt,
} from '../../lib/refdata.client';

/**
 * Check & Go intake — a vehicle CHECK service (not a repair). The order always
 * carries JAS-NAWJAS-GC "General Check", qty 1, typable price (default
 * Rp 100.000 inc tax), plus whatever work the check itself sold: the sheet's
 * Rekomendasi pre-tick the Pekerjaan card via REKOMENDASI_SERVICE, and the
 * counter edits from there. The checklist is the paper "NAWILIS CHECK and GO
 * REPORT", rendered from lib/refdata.client.ts, and is stored in OUR Mongo so
 * the customer can be told exactly what was checked/found.
 *
 * No mechanic is picked here — see the note on `showSetup` below.
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
interface TireAnswer { merkUkuran: string; tekanan: string; psi: string; flags: string[] }
const EMPTY_TIRE: TireAnswer = { merkUkuran: '', tekanan: '', psi: '', flags: [] };

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
  // No mechanic is picked at intake. At the counter the check has usually not
  // been done yet, so the tablet would be asking who WILL do it; the flow board
  // records who actually did when it raises the Work Order, which is also the
  // only moment Turboly needs a valid per-branch assignee. "Diperiksa Oleh" on
  // the print and the WhatsApp message falls back to the advisor until then.
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

  const [estimasi, setEstimasi] = useState(String(DEFAULT_ESTIMASI));
  // The paper report (final 3). Everything is keyed by the refdata codes and
  // everything is optional — an untouched sheet submits exactly like before.
  const [secVerdict, setSecVerdict] = useState<Record<string, string>>({}); // section code → its verdict code
  const [itemVerdict, setItemVerdict] = useState<Record<string, string>>({}); // item code → its verdict code
  const [reading, setReading] = useState<Record<string, string>>({}); // `${item}.${reading}` → typed value
  const [secRekom, setSecRekom] = useState<Record<string, string[]>>({}); // section code → rekomendasi picks
  const [rekomLain, setRekomLain] = useState<Record<string, string>>({}); // section code → freeText detail
  const [extraParts, setExtraParts] = useState<string[]>([]); // LAIN "Part suspensi" lines, by index
  const [tire, setTire] = useState<Record<string, TireAnswer>>({}); // position code → answers
  const [tireStd, setTireStd] = useState(''); // door-placard standard psi, one per vehicle
  const [tireRekom, setTireRekom] = useState<string[]>([]); // tire rekomendasi picks
  const [tireLain, setTireLain] = useState<string[]>([]); // the 3 blank tire lines, by index
  const router = useRouter();
  // Signatures moved to PAPER: submit opens the printout and both parties sign
  // there — the printed form is the consent document now.
  const [result, setResult] = useState<{ ok: boolean; text: string; token?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
  // Turboly keeps TWO rosters per store and an advisor is not automatically on
  // both: YUNIAR SETYOWATI is an advisor at Pamulang but not a salesperson
  // there, and sending her name into both fields is what made D 1990 ASB fail
  // with 'Salesperson can't be blank'. 11 of 26 stores have such a person, so
  // the salesperson has to be answerable separately when the advisor is not one.
  const [salespeople, setSalespeople] = useState<{ code: string; name: string }[]>([]);
  const [salesperson, setSalesperson] = useState('');

  /**
   * "Diperiksa Oleh" — the footer field of the paper sheet, and the only one of
   * the three people on this form the paper actually asks for.
   *
   * Free text with the branch's mechanics as suggestions, and never required:
   * it names who did the check on the printout and in the customer's WhatsApp,
   * so it must accept whoever that was, including someone Turboly has never
   * heard of. It is NOT the Work Order assignee — that is a Turboly store-user
   * id, chosen on the flow board at Buat Work Order, where it is enforced.
   */
  const [inspector, setInspector] = useState('');
  const [mekanikList, setMekanikList] = useState<{ code: string; name: string }[]>([]);

  /**
   * The work the customer is being sold on the back of this check.
   *
   * It is pre-ticked from the Rekomendasi the checker already marked on the
   * sheet — the sheet IS the recommendation, so asking again would be asking
   * twice — but it stays fully editable: the customer may decline, or want
   * something the checker did not write down. `auto` remembers which ticks this
   * form made, so un-ticking one Rekomendasi retracts only its own job and
   * never a job a human chose.
   */
  const [jobs, setJobs] = useState<Record<string, { qty: number | ''; sku?: string; brandType?: string; auto?: boolean }>>({});
  const [svcOpts, setSvcOpts] = useState<Record<string, { defaultSku: string; options: { sku: string; label: string }[] }>>({});
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

  useEffect(() => {
    fetch('/api/vehicle-makes').then((r) => r.json()).then((d) => setMakes(d.makes ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    fetch('/api/service-options').then((r) => r.json()).then((d) => setSvcOpts(d.services ?? {})).catch(() => {});
  }, []);

  // Drain anything parked offline while this page is open — otherwise a queued
  // Check & Go would wait for someone to visit the SPK form, which on a
  // check-only tablet may be never.
  useEffect(() => {
    void flush();
    const t = setInterval(() => { void flush(); }, 20_000);
    return () => clearInterval(t);
  }, []);

  // The services the ticked Rekomendasi imply. A Set, because two tyre
  // recommendations can name the same service card.
  const recommended = useMemo(() => {
    const out = new Set<string>();
    for (const sec of CHECKGO_SECTIONS) {
      for (const c of secRekom[sec.code] ?? []) {
        const svc = REKOMENDASI_SERVICE[`${sec.code}:${c}`];
        if (svc) out.add(svc);
      }
    }
    for (const c of tireRekom) {
      const svc = REKOMENDASI_SERVICE[`${CHECKGO_TIRE.code}:${c}`];
      if (svc) out.add(svc);
    }
    return out;
  }, [secRekom, tireRekom]);

  // Mirror the recommendations into the job selection, touching ONLY the ticks
  // this effect owns: a job the operator added by hand survives un-ticking its
  // recommendation, and one they deliberately removed is not silently restored.
  useEffect(() => {
    setJobs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const code of recommended) {
        if (next[code]) continue;
        // A 'pcs' service on this sheet is always per wheel, and a car has
        // four — starting at 1 would make every tyre job wrong by default.
        const unit = SERVICES.find((s) => s.code === code)?.unit;
        next[code] = { qty: unit === 'pcs' ? 4 : 1, auto: true };
        changed = true;
      }
      for (const [code, sel] of Object.entries(next)) {
        if (sel.auto && !recommended.has(code)) { delete next[code]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [recommended]);
  const [kind, setKind] = useState<'car' | 'motorcycle'>('car');
  useEffect(() => {
    const m = merk.trim();
    if (!m) { setModels([]); setMakeKnown(false); return; }
    let live = true;
    // kind narrows the datalist for the four twin-name makes (HONDA the carmaker
    // vs HONDA the bikemaker) — same split the SPK forms already send.
    fetch(`/api/vehicle-models?make=${encodeURIComponent(m)}&kind=${kind}`).then((r) => r.json())
      .then((d) => { if (live) { setModels(d.models ?? []); setMakeKnown(!!d.known); } }).catch(() => {});
    return () => { live = false; };
  }, [merk, kind]);
  useEffect(() => {
    if (!branch) { setAdvisors([]); setSalespeople([]); setSalesperson(''); setMekanikList([]); return; }
    let live = true;
    // Both rosters are per store, so a pick made under the previous branch is
    // dropped rather than carried into a store it does not belong to.
    setSalesperson('');
    fetch(`/api/mechanics?branch=${encodeURIComponent(branch)}`).then((r) => r.json())
      .then((d: { mechanics?: Array<{ code?: string; name?: string }> }) => {
        if (live) setMekanikList((d.mechanics ?? []).map((m) => ({ code: String(m.code ?? ''), name: String(m.name ?? '') })).filter((m) => m.name));
      }).catch(() => { if (live) setMekanikList([]); });
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`).then((r) => r.json())
      .then((d) => { if (live) { setAdvisors(d.advisors ?? []); setSalespeople(d.salespeople ?? []); } }).catch(() => {});
    return () => { live = false; };
  }, [branch]);

  // The salesperson tracks the advisor for as long as nobody has overridden the
  // box: pick an advisor who is on both rosters and the field fills itself;
  // switch to a different advisor and it follows, instead of leaving the
  // previous person credited. The moment someone chooses a salesperson by hand
  // it stops following — a ref, not state, so the effect cannot loop on itself.
  const salesAuto = useRef(true);
  useEffect(() => {
    if (!salespeople.length) return;
    setSalesperson((prev) => {
      if (prev && !salesAuto.current) return prev;
      const m = salespeople.find((s) => s.name.toUpperCase() === advisor.trim().toUpperCase());
      return m ? m.name : '';
    });
  }, [advisor, salespeople]);

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
    setSecRekom((p) => {
      const cur = p[sec] ?? [];
      if (cur.includes(code)) return { ...p, [sec]: cur.filter((c) => c !== code) };
      // Turning a pick ON drops the ones it contradicts ("dibersihkan" vs
      // "ganti" for the same filter) — both on one WhatsApp is a question,
      // not a recommendation.
      const excludes = CHECKGO_SECTIONS.find((x) => x.code === sec)?.rekomendasi.find((o) => o.code === code)?.excludes ?? [];
      return { ...p, [sec]: [...cur.filter((c) => !excludes.includes(c)), code] };
    });
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

  // Estimasi optional — blank falls back to the 30-minute default.
  const jobCount = Object.keys(jobs).length;
  const estimasiVal = estimasi.trim() === '' ? DEFAULT_ESTIMASI : Number(estimasi.trim());
  const estimasiOk = Number.isInteger(estimasiVal) && estimasiVal > 0;
  const kmValQ = /\d/.test(km) ? Number(km.replace(/[.\s]/g, '')) : NaN;
  const kmBelowPrev = hist?.lastKm != null && !Number.isNaN(kmValQ) && kmValQ < hist.lastKm;
  const makeUnknown = merk.trim() !== '' && makes.length > 0 && !makes.some((m) => m.toUpperCase() === merk.trim().toUpperCase());
  const modelUnknown = tipe.trim() !== '' && makeKnown && models.length > 0 && !models.some((m) => m.toUpperCase() === tipe.trim().toUpperCase());
  const advisorUnknown = advisor.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === advisor.trim().toUpperCase());

  // Turboly stars BOTH Service Advisor and Salesperson — neither may be blank —
  // and it fills them from two per-store rosters that only mostly overlap. So
  // the salesperson is asked for outright, pre-selected to the advisor whenever
  // she is on that roster too (the common case, no taps) and left blank when
  // she is not, which is exactly the case that used to fail the push hours
  // later in /admin instead of at the counter.
  // A roster that never loaded must not lock the branch out: with no list we
  // cannot tell who is eligible, so we send the advisor and let Turboly judge.
  const salespersonKnown = salespeople.length > 0;
  const effSalesperson = salespersonKnown ? salesperson.trim() : advisor.trim();
  const salespersonOk = effSalesperson !== '';

  // The report IS the product being sold: every section answered, every wheel's
  // pressure recorded. "Semua baik" makes the healthy car eight taps.
  const reportOk =
    CHECKGO_SECTIONS.every((s2) => sectionSlots(s2) === 0 || sectionDone(s2) === sectionSlots(s2)) &&
    CHECKGO_TIRE.positions.every((p2) => (tire[p2.code]?.tekanan ?? '') !== '');
  const canSubmit = !!branch && waOk && namaOk && alamatOk && plateOk && merkOk && tipeOk && tahunOk && warnaOk && kmOk && advisorOk && salespersonOk && estimasiOk && reportOk && !submitting;

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
      },
      vehicle: {
        noPolisi: plate,
        kind,
        merk: merk || null,
        tipe: tipe || null,
        tahun: tahun ? Number(tahun) : null,
        warna: warna || null,
        km,
      },
      complaint: null,
      estimasiMinutes: estimasiVal,
      serviceAdvisorName: advisor || null,
      salespersonName: effSalesperson || null,
      // Who did the check — the paper's "Diperiksa Oleh". Name only: the Work
      // Order assignee is a Turboly id and is chosen on the flow board.
      mechanicName: inspector.trim() || null,
      // The services the checker recommended and the counter confirmed. These
      // join the fixed General Check line on the Turboly order; the server
      // decides what "filled in" means, so this sends exactly what is ticked.
      jobLines: SERVICES.filter((s) => jobs[s.code]).map((s) => ({
        serviceCode: s.code,
        ordered: true,
        qty: Number(jobs[s.code]!.qty) || 1,
        quotedPrice: null,
        chosenSku: jobs[s.code]!.sku || svcOpts[s.code]?.defaultSku || null,
        keterangan: jobs[s.code]!.brandType?.trim() || null,
      })),
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
          return { position: p.code, merkUkuran: t.merkUkuran || null, tekanan: t.tekanan || null, psi: t.psi.trim() || null, flags: t.flags };
        }),
        tireRekomendasi: {
          picks: tireRekom,
          lain: Array.from({ length: CHECKGO_TIRE.freeLines }, (_, i) => tireLain[i] ?? ''),
        },
        tekananStandar: tireStd.trim() || null,
      },
      signatures: {
        menyerahkanPresent: true,
        menyerahkanNamaJelas: nama || null,
        menerimaPresent: !!advisor,
        menerimaNamaJelas: advisor || null,
        menyerahkanImage: null,
        menerimaImage: null,
      },
    };
    try {
      // Through the outbox, like the two SPK forms. A Check & Go is eight
      // sections of work that only exists on this tablet until it lands: losing
      // it to a dropped connection means doing the whole inspection again, on a
      // car that may already have left.
      const res = await submitOrQueue(payload.uploadId, payload, '/api/checkgo');
      if (res === 'queued') { setResult({ ok: true, text: '✓ Tersimpan offline — akan dikirim otomatis saat online.' }); resetForm(); setSubmitting(false); return; }
      if (res === 'queued_no_images') { setResult({ ok: true, text: '✓ Tersimpan offline (tanda tangan gambar dilepas — penyimpanan penuh). Akan dikirim otomatis saat online.' }); resetForm(); setSubmitting(false); return; }
      if (res === 'lost') { setResult({ ok: false, text: '✗ GAGAL menyimpan: penyimpanan perangkat penuh & tidak ada koneksi. Data TIDAK tersimpan — jangan tutup halaman, hubungkan internet lalu coba lagi.' }); setSubmitting(false); return; }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const notes = (body.findings ?? []).map((f: { message: string }) => f.message).join('; ');
        if (body.needsReview) {
          setResult({ ok: false, text: `Tersimpan, perlu diperbaiki: ${notes}`, token: body.correlationToken });
        } else {
          // Straight to the printout — that is where the customer signs now.
          resetForm();
          router.push(`/checkgo/${body.spkId}/print?print=1`);
          return;
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
    setPlate(''); setMerk(''); setTipe(''); setTahun(''); setWarna(''); setKm(''); setKind('car');
    setHist(null); setPlateOwner(null); setCustVehicles([]); setCustHint(null); setRegName(null);
    setEstimasi(String(DEFAULT_ESTIMASI));
    setSecVerdict({}); setItemVerdict({}); setReading({});
    setSecRekom({}); setRekomLain({}); setExtraParts([]);
    setTire({}); setTireRekom([]); setTireLain([]); setTireStd('');
    setJobs({});
    // Advisor must be a deliberate choice per order — never carried over.
    setAdvisor('');
    setSalesperson('');
    setInspector('');
  }

  return (
    <>
      <div className="topbar">
        <BrandMark page="CHECK & GO" />
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '0 16px' }}>
          <div>
          <div className="label">Nomor WhatsApp — ketik dulu</div>
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

          <div>
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
          </div>
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
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {(['car', 'motorcycle'] as const).map((k) => (
                  <button key={k} type="button" className={`chk-chip${kind === k ? ' ok' : ''}`} onClick={() => setKind(k)}>
                    {k === 'car' ? '🚗 Mobil' : '🏍 Motor'}
                  </button>
                ))}
              </div>
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
          {/* The fixed line and one optional number — a whole card of chrome
              for that was scroll distance, not information. The count of extra
              jobs is here because they are chosen much further down the page:
              this is the only place the whole order is visible at once. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="label" style={{ marginBottom: 0 }}>Pekerjaan</span>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>
              General Check (JAS-NAWJAS-GC) · 1×
              {jobCount > 0 && ` + ${jobCount} pekerjaan`}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Estimasi</span>
              <input value={estimasi} onChange={(e) => setEstimasi(e.target.value)} inputMode="numeric" placeholder="30" style={{ ...(!estimasiOk ? { borderColor: '#dc2626' } : {}), width: 64, fontSize: 16, padding: '4px 8px' }} />
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>menit</span>
            </span>
          </div>
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
                ...CHECKGO_SECTIONS.filter((s2) => sectionSlots(s2) > 0 && sectionDone(s2) < sectionSlots(s2)).map((s2) => s2.title),
                ...(CHECKGO_TIRE.positions.some((p2) => (tire[p2.code]?.tekanan ?? '') === '') ? ['Tekanan ban (semua roda)'] : []),
              ].join(' · ')}
            </div>
          )}

          {/* Sections 1-7: per-row verdict pairs + readings, each section with
              its own recommendation checklist right under it (the printed
              layout). */}
          {CHECKGO_SECTIONS.map((s) => (
            <div key={s.code} id={`cg-sec-${s.no}`} style={SEC_SEP}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* No printed numbers — incompleteness is shown where it is,
                    in red, instead of as a chip rail to a numbered section. */}
                <span style={{ ...SEC_TITLE, flex: '1 1 auto', ...(sectionSlots(s) > 0 && sectionDone(s) < sectionSlots(s) ? { color: '#dc2626' } : {}) }}>
                  {s.title}{' '}
                  {sectionSlots(s) > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: sectionDone(s) === sectionSlots(s) ? '#15803d' : '#dc2626' }}>
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
              {s.items.map((it) => {
                // A bad verdict with no measurement is the finding the customer
                // cannot verify — "outside range" without the range's reading.
                // Amber, not a submit gate: some rows genuinely have nothing
                // measurable left (a dead battery reads nothing).
                const bad = !!it.verdicts && !!itemVerdict[it.code] && itemVerdict[it.code] !== it.verdicts[0]!.code;
                const unread = bad && !!it.readings?.length
                  && it.readings.every((r) => !(reading[`${it.code}.${r.code}`] ?? '').trim());
                return (
                <div key={it.code} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
                  <span className="chk-label" style={{ flex: '1 1 140px', fontSize: 12.5, ...(it.verdicts && !itemVerdict[it.code] ? { color: '#dc2626' } : {}) }}>{it.label}</span>
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
                            style={{ ...SMALL_INPUT, width: r.code === 'TGL' ? 110 : 90, ...(unread ? { borderColor: '#d97706' } : {}) }}
                          />
                        )}
                        {r.suffix && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.suffix}</span>}
                      </span>
                    );
                  })}
                  {unread && <span style={{ fontSize: 11, color: '#d97706' }}>⚠ tulis hasil ukur — dikirim ke customer</span>}
                  {it.verdicts && (
                    <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                      {verdictButtons(it.verdicts, itemVerdict[it.code] ?? '', (code) =>
                        setItemVerdict((p) => ({ ...p, [it.code]: code })),
                      )}
                    </span>
                  )}
                </div>
                );
              })}
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
            <div style={{ ...SEC_TITLE, marginBottom: 6, ...(CHECKGO_TIRE.positions.some((p2) => (tire[p2.code]?.tekanan ?? '') === '') ? { color: '#dc2626' } : {}) }}>{CHECKGO_TIRE.title}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Standar tekanan (placard pintu)</span>
              <input value={tireStd} onChange={(e) => setTireStd(e.target.value)} placeholder="cth: 33/36" style={{ ...SMALL_INPUT, width: 90 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>psi</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(250px, 100%), 1fr))', gap: 8 }}>
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
                    <span style={{ flex: '1 1 90px', fontSize: 12.5, color: t.tekanan ? 'var(--muted)' : '#dc2626' }}>Tekanan angin</span>
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
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <input
                        value={t.psi}
                        onChange={(e) => setTireOf(pos.code, { psi: e.target.value })}
                        inputMode="numeric"
                        placeholder="ukur"
                        // Amber on an abnormal verdict without the number: the
                        // WhatsApp says "terlalu tinggi (terukur … psi)" only
                        // when the checker wrote the psi down.
                        style={{ ...SMALL_INPUT, width: 52, ...(t.tekanan && t.tekanan !== 'CUKUP' && !t.psi.trim() ? { borderColor: '#d97706' } : {}) }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>psi</span>
                    </span>
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
          <div className="label">Pekerjaan yang diorder</div>
          <div className="hint" style={{ fontSize: 12, color: 'var(--muted, #667)', marginBottom: 8 }}>
            Otomatis tercentang dari Rekomendasi di atas — ubah kalau customer menolak atau minta tambahan.
            General Check selalu ikut.
          </div>
          <div className="tiles">
            {SERVICES.map((s) => {
              const sel = jobs[s.code];
              const on = !!sel;
              const fromSheet = !!sel?.auto;
              return (
                <button
                  key={s.code}
                  type="button"
                  className={`tile ${on ? 'on' : ''}`}
                  // A manual tap always wins, and takes ownership: clearing
                  // `auto` stops the Rekomendasi effect from ever reclaiming it.
                  onClick={() =>
                    setJobs((p) => {
                      const next = { ...p };
                      if (next[s.code]) delete next[s.code];
                      else next[s.code] = { qty: s.unit === 'pcs' ? 4 : 1 };
                      return next;
                    })
                  }
                >
                  {s.label}
                  {fromSheet && <span style={{ display: 'block', fontSize: 10, opacity: 0.75 }}>dari rekomendasi</span>}
                  {on && s.unit !== 'check' && (
                    <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                      <input
                        type="number"
                        min={1}
                        value={sel.qty}
                        // '' is a legal mid-edit state: snapping straight back to 1
                        // made the box impossible to clear-and-retype ("1 liter bug").
                        onChange={(e) => { const v = e.target.value; setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, qty: v === '' ? '' : Math.max(1, Math.floor(Number(v)) || 1) } })); }}
                        onBlur={() => setJobs((p) => (p[s.code]?.qty === '' ? { ...p, [s.code]: { ...p[s.code]!, qty: 1 } } : p))}
                        style={{ width: 64, fontSize: 12, padding: '6px 8px' }}
                      />
                      <span style={{ fontSize: 11, color: 'var(--muted, #667)' }}>{s.unit}</span>
                    </span>
                  )}
                  {on && s.catalog?.length ? (
                    <span onClick={(e) => e.stopPropagation()} style={{ display: 'block', marginTop: 6 }}>
                      <ProductInput
                        cat={s.catalog[0]!}
                        value={sel.brandType ?? ''}
                        onChange={(v) => setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, brandType: v } }))}
                        placeholder={s.code === 'OLI' ? 'merk / tipe — contoh: Castrol Edge 5W-30' : 'merk / tipe — pilih atau ketik'}
                        style={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
                      />
                    </span>
                  ) : null}
                  {/* The variant dropdown is what separates Ganti Ban from
                      Rotasi Ban — both recommendations tick the same card. */}
                  {on && svcOpts[s.code]?.options?.length ? (
                    <select
                      value={sel.sku || svcOpts[s.code]!.defaultSku}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setJobs((p) => ({ ...p, [s.code]: { ...p[s.code]!, sku: e.target.value } }))}
                      style={{ marginTop: 6, fontSize: 12, padding: '6px 8px', maxWidth: '100%' }}
                    >
                      {svcOpts[s.code]!.options.map((o) => <option key={o.sku} value={o.sku}>{o.label}</option>)}
                    </select>
                  ) : null}
                </button>
              );
            })}
          </div>
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
          <div className="label" style={{ marginTop: 12 }}>Diperiksa oleh (mekanik)</div>
          <input list="mekanik-list-cg" value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder={mekanikList.length ? 'Pilih dari daftar / ketik' : 'Nama pemeriksa — boleh dikosongkan'} />
          <datalist id="mekanik-list-cg">{mekanikList.map((m) => <option key={m.code} value={m.name} />)}</datalist>
          <div className="hint" style={{ fontSize: 11, color: 'var(--muted, #667)', marginTop: 2 }}>
            Tercetak di &quot;Diperiksa Oleh&quot; dan dikirim ke customer lewat WhatsApp. Kosong = nama advisor.
          </div>

          <div className="label" style={{ marginTop: 12 }}>Yang menerima (Service Advisor) — WAJIB</div>
          <input list="advisor-list-cg" value={advisor} onChange={(e) => setAdvisor(e.target.value)} placeholder={advisors.length ? 'Pilih dari daftar / ketik' : 'Nama advisor'} style={!advisorOk ? { borderColor: '#dc2626' } : advisorUnknown ? { borderColor: '#d97706' } : undefined} />
          <datalist id="advisor-list-cg">{advisors.map((a) => <option key={a.code} value={a.name} />)}</datalist>
          {!advisorOk && <div className="req-note">⚠ wajib — Turboly menolak order tanpa advisor</div>}
          {advisorUnknown && <div className="warn-note">⚠ Tidak ada di daftar advisor cabang — harus sama persis dengan nama di Turboly, atau order gagal.</div>}

          {/* A select, not a datalist: a typo here is the exact failure this
              replaces, and unlike the advisor there is no "new salesperson"
              case — the name must already exist in Turboly. */}
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

        <div className="card">
          <div className="label">Tanda tangan</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Setelah Simpan, laporan cetak terbuka otomatis — customer dan advisor
            tanda tangan di kertas.
          </div>
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
          {submitting ? 'Menyimpan…' : 'Simpan Check & Go'}
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
