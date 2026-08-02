'use client';

import { useEffect, useMemo, useState } from 'react';
import { SERVICES, BRANCHES, CONDITION_ITEMS, DAMAGE_ZONES } from '../../lib/refdata.client';
import { submitOrQueue } from '../../lib/outbox';

/** Pixel-faithful, fillable replica of the Nawilis SPK (Surat Perintah Kerja). */
function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Turboly base for "add it there" deep-links (switch via env at prod go-live). */
const TURBOLY_URL = process.env.NEXT_PUBLIC_TURBOLY_BASE_URL ?? 'https://sandbox.turboly.com';

interface PkRow { order: boolean; qty: number; keterangan: string; mk: string; waktu: string; sku?: string; harga?: string }
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
  const [branch, setBranch] = useState('');
  const [extra1, setExtra1] = useState('');
  const [extra2, setExtra2] = useState('');
  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
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
    fetch(`/api/vehicle-models?make=${encodeURIComponent(m)}`)
      .then((r) => r.json())
      .then((d) => { if (live) { setModels(d.models ?? []); setMakeKnownInModels(!!d.known); } })
      .catch(() => { if (live) { setModels([]); setMakeKnownInModels(false); } });
    return () => { live = false; };
  }, [merk]);

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
  const advisorUnknown = menerima.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === menerima.trim().toUpperCase());

  // Load the real service advisors for the chosen branch (synced from Turboly).
  useEffect(() => {
    if (!branch) { setAdvisors([]); return; }
    let live = true;
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`)
      .then((r) => r.json())
      .then((d) => { if (live) setAdvisors(d.advisors ?? []); })
      .catch(() => { if (live) setAdvisors([]); });
    return () => { live = false; };
  }, [branch]);

  const [pk, setPk] = useState<Record<string, PkRow>>(() =>
    Object.fromEntries(SERVICES.map((s) => [s.code, { order: false, qty: 1, keterangan: '', mk: '', waktu: '' }])),
  );
  // Raw detail fields that map 1:1 to the Nawilis export columns.
  const [merekOli, setMerekOli] = useState('');
  const [tipeOli, setTipeOli] = useState('');
  const [merekBan, setMerekBan] = useState('');
  const [tipeBan, setTipeBan] = useState('');
  const [namaCs, setNamaCs] = useState('');
  const [prevMerekOli, setPrevMerekOli] = useState('');
  const [prevTipeOli, setPrevTipeOli] = useState('');
  const [prevBengkel, setPrevBengkel] = useState('');
  const [prevKmOli, setPrevKmOli] = useState('');
  const [cond, setCond] = useState<Record<string, string>>(() =>
    Object.fromEntries(CONDITION_ITEMS.map((c) => [c.code, 'OK'])),
  );
  const [dmg, setDmg] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setRow = (code: string, patch: Partial<PkRow>) => setPk((p) => ({ ...p, [code]: { ...p[code]!, ...patch } }));
  const toggleDmg = (z: string) => setDmg((s) => { const n = new Set(s); n.has(z) ? n.delete(z) : n.add(z); return n; });

  const orderedCount = useMemo(() => Object.values(pk).filter((r) => r.order).length, [pk]);

  async function submit() {
    setSubmitting(true);
    setResult(null);
    const uploadId = uuid();
    const jobLines = SERVICES.filter((s) => pk[s.code]!.order).map((s) => {
      const r = pk[s.code]!;
      const notes = [r.keterangan, r.mk && `MK:${r.mk}`, r.waktu && `Waktu:${r.waktu}`].filter(Boolean).join(' ');
      const harga = r.harga ? Number(r.harga.replace(/[^\d]/g, '')) : NaN;
      return { serviceCode: s.code, ordered: true, qty: r.qty || 1, keterangan: notes || null, quotedPrice: Number.isFinite(harga) && harga > 0 ? harga : null, chosenSku: r.sku || svcOpts[s.code]?.defaultSku || null };
    });
    const conditionChecks = CONDITION_ITEMS.map((c) => ({ item: c.code, marks: cond[c.code] === 'OK' ? [] : [cond[c.code]!] }));
    const dmgSummary = [...dmg].map((z) => DAMAGE_ZONES.find((d) => d.code === z)?.label ?? z).join(', ');
    const complaint = [keluhan, dmgSummary && `Kerusakan bodi: ${dmgSummary}`].filter(Boolean).join(' | ') || null;

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
      vehicle: { noPolisi: noPol, merk: merk || null, tipe: tipe || null, tahun: tahun ? Number(tahun) : null, warna: warna || null, km, createMakeConfirmed: makeUnknown && createMakeOk },
      complaint,
      jobLines,
      conditionChecks,
      rekomendasiService: rekom || null,
      estimasiMinutes: estimasi ? Number(estimasi) : null,
      serviceAdvisorName: menerima || null,
      salespersonName: menerima || null,
      signatures: { menyerahkanPresent: !!menyerahkan, menerimaPresent: !!menerima, menerimaNamaJelas: menerima || null },
      // Verbatim raw fields → reproduce the Nawilis export columns exactly.
      raw: {
        merek_oli: merekOli, tipe_oli: tipeOli, merek_ban: merekBan, tipe_ban: tipeBan,
        nama_cs: namaCs || menerima, kontak_lainnya: kontakLain, nama_customer_menyerahkan: menyerahkan,
        merek_oli_sebelumnya: prevMerekOli, tipe_oli_sebelumnya: prevTipeOli, bengkel_sebelumnya: prevBengkel, km_ganti_oli_sebelumnya: prevKmOli,
        service_lain: [extra1, extra2].filter(Boolean).join(', '),
      },
    };

    // Branch routes the Turboly store; WA is REQUIRED (customer identity key).
    // Everything else is allowed through — the server warns instead of refusing.
    if (!branch) { setResult({ ok: false, text: 'Pilih cabang dulu (di bawah).' }); setSubmitting(false); return; }
    if (wa.replace(/\D/g, '').length < 9) { setResult({ ok: false, text: 'Nomor WhatsApp wajib diisi — min. 9 digit.' }); setSubmitting(false); return; }

    // NO submit-time gate: warnings live at the fields themselves (the person
    // filling out sees them and simply continues) — Simpan sends immediately.
    await send(uploadId, payload);
  }

  /** Actually save + push (used by the clean path and the SIMPAN PAKSA override button). */
  async function send(uploadId: string, payload: unknown) {
    setSubmitting(true);
    const res = await submitOrQueue(uploadId, payload);
    if (!res) { setResult({ ok: true, text: '✓ Tersimpan offline — akan dikirim otomatis saat online.' }); setSubmitting(false); return; }
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const notes = (body.findings ?? []).map((f: { message: string }) => f.message).join('; ');
      const msg = body.needsReview
        ? 'Tersimpan, perlu diperbaiki: '
        : body.state === 'queued'
          ? '✓ Tersimpan & langsung dikirim ke Turboly. '
          : `✓ Tersimpan ke MongoDB (${body.state}). `;
      setResult({ ok: !body.needsReview, text: msg + notes });
    } else setResult({ ok: false, text: body.error ?? 'Gagal menyimpan.' });
    setSubmitting(false);
  }

  return (
    <div className="sheet-wrap">
      <div className="sheet">
        {/* Header */}
        <div className="hd">
          <div className="logo">
            <svg className="mark" viewBox="0 0 40 40" aria-label="NAWILIS">
              <rect width="40" height="40" rx="6" fill="#0a3d8f" />
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
            <div className="fld"><label>Nama</label><input value={nama} onChange={(e) => setNama(e.target.value)} /></div>
            <div className="fld"><label>Alamat</label><input value={alamat} onChange={(e) => setAlamat(e.target.value)} /></div>
            <div className="fld"><label>Nomor WhatsApp</label>
              <div>
                <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="Nomor WhatsApp — WAJIB (08…)" style={wa.replace(/\D/g, '').length < 9 ? { borderColor: '#d97706' } : undefined} />
                {wa.replace(/\D/g, '').length < 9 && <div className="warn-inline">⚠ Nomor WhatsApp <b>wajib</b> — identitas pelanggan (min. 9 digit).</div>}
              </div>
            </div>
          </div>
          <div className="box">
            <span className="sec-h">INFORMASI KENDARAAN</span>
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
                      <td className="svc" onClick={() => setRow(s.code, { order: !r.order })}>{s.label.toUpperCase()}</td>
                      <td className="tick-cell" style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <span className={`tick ${r.order ? 'on' : ''}`} onClick={() => setRow(s.code, { order: !r.order })}>{r.order ? '✓' : '▢'}</span>
                        {r.order && <input type="number" min={1} value={r.qty} onChange={(e) => setRow(s.code, { qty: Math.max(1, Number(e.target.value) || 1) })} className="qty" style={{ width: 26, padding: 0, textAlign: 'center', display: 'inline-block' }} />}
                      </td>
                      <td className="ket-cell">
                        {r.order && svcOpts[s.code]?.options?.length ? (
                          <select value={r.sku || svcOpts[s.code]!.defaultSku} onChange={(e) => setRow(s.code, { sku: e.target.value })} style={{ width: '100%', marginBottom: 3, fontSize: 11 }}>
                            {svcOpts[s.code]!.options.map((o) => <option key={o.sku} value={o.sku}>{o.label}</option>)}
                          </select>
                        ) : null}
                        {r.order && <input type="text" value={r.keterangan} onChange={(e) => setRow(s.code, { keterangan: e.target.value })} placeholder="keterangan" />}
                        {r.order && <input type="text" value={r.harga ?? ''} onChange={(e) => setRow(s.code, { harga: e.target.value })} inputMode="numeric" placeholder="Harga (Rp)" style={{ marginTop: 3 }} />}
                        {!r.order && <input className="ket-idle" type="text" value={r.keterangan} onChange={(e) => setRow(s.code, { keterangan: e.target.value })} placeholder="keterangan" />}
                      </td>
                      <td className="col-mk"><input type="text" value={r.mk} onChange={(e) => setRow(s.code, { mk: e.target.value })} /></td>
                      <td className="col-waktu"><input type="text" value={r.waktu} onChange={(e) => setRow(s.code, { waktu: e.target.value })} /></td>
                    </tr>
                  );
                })}
                <tr><td className="col-num" style={{ textAlign: 'center' }}>13</td><td className="svc"><input value={extra1} onChange={(e) => setExtra1(e.target.value)} placeholder="Pekerjaan lain…" /></td><td className="tick-cell" /><td className="ket-cell" /><td className="col-mk" /><td className="col-waktu" /></tr>
                <tr><td className="col-num" style={{ textAlign: 'center' }}>14</td><td className="svc"><input value={extra2} onChange={(e) => setExtra2(e.target.value)} placeholder="Pekerjaan lain…" /></td><td className="tick-cell" /><td className="ket-cell" /><td className="col-mk" /><td className="col-waktu" /></tr>
              </tbody>
            </table>
          </div>
          <div>
            <div className="box" style={{ height: '100%' }}>
              <div style={{ fontSize: 9, fontWeight: 700, marginBottom: 2 }}>Pengecekan bodi — klik bagian yang rusak:</div>
              <svg className="car" viewBox="0 0 360 520" style={{ display: 'block', margin: '0 auto', width: '100%', maxWidth: 300 }}>
                {/* tyre discs behind the clickable wheel zones */}
                {[[40, 70], [320, 70], [40, 450], [320, 450]].map(([wx, wy], i) => (
                  <circle key={i} cx={wx} cy={wy} r="27" fill="#3a3a3a" />
                ))}
                {/* car body outline */}
                <rect x="80" y="8" width="200" height="500" rx="34" fill="#f7faff" stroke="var(--nawilis)" strokeWidth="1.5" />
                {/* clickable zones (rects + wheel circles) */}
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
                {/* emblem L/R markers + orientation */}
                <text x="90" y="39" textAnchor="middle" fontSize="8" fill="#333" pointerEvents="none">L</text>
                <text x="270" y="39" textAnchor="middle" fontSize="8" fill="#333" pointerEvents="none">R</text>
                <text x="90" y="473" textAnchor="middle" fontSize="8" fill="#333" pointerEvents="none">L</text>
                <text x="270" y="473" textAnchor="middle" fontSize="8" fill="#333" pointerEvents="none">R</text>
                <text x="180" y="518" textAnchor="middle" fontSize="10" fill="#888" pointerEvents="none">↑ DEPAN</text>
              </svg>
              <div className="fld" style={{ marginTop: 4 }}><label style={{ fontSize: 10 }}>Estimasi (menit)</label><input value={estimasi} onChange={(e) => setEstimasi(e.target.value)} inputMode="numeric" /></div>
            </div>
          </div>
        </div>

        {/* Pengecekan awal */}
        <div style={{ marginTop: 8 }}>
          <span className="sec-h">PENGECEKAN AWAL KENDARAAN</span>
          <table className="cond">
            <tbody>
              {CONDITION_ITEMS.map((c, i) => (
                <tr key={c.code}>
                  <td style={{ width: 18, textAlign: 'center' }}>{i + 1}</td>
                  <td style={{ width: 130, fontWeight: 600 }}>{c.label}</td>
                  <td>
                    <span className={`opt ${cond[c.code] === 'OK' ? 'on' : ''}`} onClick={() => setCond((s) => ({ ...s, [c.code]: 'OK' }))}>OK</span>
                    {c.marks.map((m) => (
                      <span key={m} className={`opt ${cond[c.code] === m ? 'on' : ''}`} style={{ marginLeft: 6 }} onClick={() => setCond((s) => ({ ...s, [c.code]: m }))}>{m}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail tambahan (maps to export columns) */}
        <div className="box" style={{ marginTop: 8 }}>
          <span className="sec-h">DETAIL TAMBAHAN</span>
          <div className="two">
            <div className="fld"><label>Merek Oli</label><input value={merekOli} onChange={(e) => setMerekOli(e.target.value)} /></div>
            <div className="fld"><label>Tipe Oli</label><input value={tipeOli} onChange={(e) => setTipeOli(e.target.value)} /></div>
            <div className="fld"><label>Merek Ban</label><input value={merekBan} onChange={(e) => setMerekBan(e.target.value)} /></div>
            <div className="fld"><label>Tipe Ban</label><input value={tipeBan} onChange={(e) => setTipeBan(e.target.value)} /></div>
            <div className="fld"><label>Oli sblm (merek)</label><input value={prevMerekOli} onChange={(e) => setPrevMerekOli(e.target.value)} /></div>
            <div className="fld"><label>Oli sblm (tipe)</label><input value={prevTipeOli} onChange={(e) => setPrevTipeOli(e.target.value)} /></div>
            <div className="fld"><label>Bengkel sblm</label><input value={prevBengkel} onChange={(e) => setPrevBengkel(e.target.value)} /></div>
            <div className="fld"><label>KM ganti oli sblm</label><input value={prevKmOli} onChange={(e) => setPrevKmOli(e.target.value)} inputMode="numeric" /></div>
            <div className="fld"><label>Nama CS</label><input value={namaCs} onChange={(e) => setNamaCs(e.target.value)} /></div>
          </div>
        </div>

        {/* Authorization + signatures */}
        <div className="auth">
          Saya yang bertanda tangan dibawah ini memberi wewenang penuh kepada bengkel NAWILIS untuk melakukan pekerjaan sesuai dengan permintaan order di atas dan test jalan apabila diperlukan.
        </div>
        <div className="sign">
          <div className="b">Yang menyerahkan,<input value={menyerahkan} onChange={(e) => setMenyerahkan(e.target.value)} placeholder="Nama jelas & tanda tangan" /></div>
          <div className="b">Yang menerima,
            <input
              list="advisor-list"
              value={menerima}
              onChange={(e) => setMenerima(e.target.value)}
              placeholder={advisors.length ? 'Pilih dari daftar atau ketik nama baru' : (branch ? 'Nama jelas & tanda tangan' : 'Pilih cabang dulu / ketik nama')}
            />
            <datalist id="advisor-list">
              {advisors.map((a) => <option key={a.code} value={a.name} />)}
            </datalist>
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
          {submitting ? 'Menyimpan…' : `Simpan SPK ke MongoDB (${orderedCount} pekerjaan)`}
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
