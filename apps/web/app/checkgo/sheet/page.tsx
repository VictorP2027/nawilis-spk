'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BRANCHES } from '../../../lib/refdata.client';
import { useBranches } from '../../../lib/branches.client';
import { submitOrQueue, flush } from '../../../lib/outbox';

/**
 * Compact, printable paper-style Check & Go form — the /sheet look, reduced to
 * the check-only flow: one General Check line (typable price, default
 * Rp 100.000), optional detailed inspection rows, customer signature.
 * Submits the SAME payload to POST /api/checkgo as /checkgo.
 */

interface InspRow { id: string; item: string; catatan: string }
interface CustVehicle { plate: string; merk: string | null; tipe: string | null; tahun: number | null; warna: string | null }

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_HARGA = 100_000;
const DEFAULT_ESTIMASI = 30;

export default function CheckGoSheet() {
  // Compiled-in list, plus any branch opened since the last deploy — the
  // static BRANCHES import alone left a new counter unable to pick itself.
  const BRANCHES = useBranches();
  const [serial, setSerial] = useState('');
  const [branch, setBranch] = useState('');
  const [wa, setWa] = useState('');
  const [nama, setNama] = useState('');
  const [alamat, setAlamat] = useState('');
  const [noPol, setNoPol] = useState('');
  const [merk, setMerk] = useState('');
  const [tipe, setTipe] = useState('');
  const [tahun, setTahun] = useState('');
  const [warna, setWarna] = useState('');
  const [km, setKm] = useState('');
  const [harga, setHarga] = useState(String(DEFAULT_HARGA));
  const [estimasi, setEstimasi] = useState(String(DEFAULT_ESTIMASI));
  const [insp, setInsp] = useState<InspRow[]>([]);
  const [menyerahkan, setMenyerahkan] = useState('');
  const [menerima, setMenerima] = useState('');
  const router = useRouter();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [advisors, setAdvisors] = useState<{ code: string; name: string }[]>([]);
  // Turboly's Salesperson is a SEPARATE per-store roster; 11 of 26 stores have
  // an advisor who is not on it, and reusing the advisor's name for both fields
  // is what makes those orders fail with "Salesperson can't be blank".
  const [salespeople, setSalespeople] = useState<{ code: string; name: string }[]>([]);
  const [salesperson, setSalesperson] = useState('');
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [makeKnownInModels, setMakeKnownInModels] = useState(false);
  const [kind, setKind] = useState<'car' | 'motorcycle'>('car');

  useEffect(() => {
    fetch('/api/vehicle-makes').then((r) => r.json()).then((d) => setMakes(d.makes ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    void flush();
    const t = setInterval(() => { void flush(); }, 20_000);
    return () => clearInterval(t);
  }, []);
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
  useEffect(() => {
    if (!branch) { setAdvisors([]); setSalespeople([]); setSalesperson(''); return; }
    let live = true;
    setSalesperson(''); // both rosters are per store — a stale pick is a wrong pick
    fetch(`/api/advisors?branch=${encodeURIComponent(branch)}`)
      .then((r) => r.json())
      .then((d) => { if (live) { setAdvisors(d.advisors ?? []); setSalespeople(d.salespeople ?? []); } })
      .catch(() => { if (live) { setAdvisors([]); setSalespeople([]); } });
    return () => { live = false; };
  }, [branch]);


  // PHONE-FIRST lookup: WA number → person + car(s); chips switch cars.
  const [custVehicles, setCustVehicles] = useState<CustVehicle[]>([]);
  const [custHint, setCustHint] = useState<string | null>(null);
  const [regName, setRegName] = useState<string | null>(null);
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
            setRegName(d.customer.nama || null);
            if (d.customer.nama) setNama(d.customer.nama); // phone's registered name wins
            setAlamat((x) => x || d.customer.alamat || '');
            const vs: CustVehicle[] = d.vehicles ?? [];
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

  // Plate → history: returning-customer prefill (fills EMPTY fields only).
  const plateNorm = noPol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const plateBad = noPol.trim() !== '' && !/^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/.test(plateNorm);
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

  const pickVehicle = (v: CustVehicle) => {
    setNoPol(v.plate); setMerk(v.merk ?? ''); setTipe(v.tipe ?? '');
    setTahun(v.tahun ? String(v.tahun) : ''); setWarna(v.warna ?? '');
  };

  const addInsp = () => setInsp((p) => [...p, { id: uuid(), item: '', catatan: '' }]);
  const setInspRow = (id: string, patch: Partial<InspRow>) => setInsp((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const delInsp = (id: string) => setInsp((p) => p.filter((r) => r.id !== id));

  const kmVal = /\d/.test(km) ? Number(km.replace(/[.\s]/g, '').replace(/,/g, '')) : NaN;
  const kmBelowPrev = prevVisitKm != null && !Number.isNaN(kmVal) && kmVal < prevVisitKm;
  const canonK = (s: string) => s.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
  const ownerMismatch = !!plateOwner?.wa && canonK(wa).length >= 8 && canonK(plateOwner.wa) !== canonK(wa);
  const makeUnknown = merk.trim() !== '' && makes.length > 0 && !makes.some((m) => m.toUpperCase() === merk.trim().toUpperCase());
  const modelUnknown = tipe.trim() !== '' && makeKnownInModels && models.length > 0 && !models.some((m) => m.toUpperCase() === tipe.trim().toUpperCase());
  const advisorUnknown = menerima.trim() !== '' && advisors.length > 0 && !advisors.some((a) => a.name.toUpperCase() === menerima.trim().toUpperCase());
  // Turboly stars both Service Advisor and Salesperson. An unloaded roster
  // means "we cannot tell" — send the advisor and let Turboly judge, rather
  // than lock the branch out.
  const salespersonKnown = salespeople.length > 0;
  const effSalesperson = salespersonKnown ? salesperson.trim() : menerima.trim();
  const hargaVal = Number(harga.replace(/[^\d]/g, ''));
  const hargaOk = Number.isFinite(hargaVal) && hargaVal > 0;
  const waNat = wa.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
  const waOk = /^8\d{8,11}$/.test(waNat);

  async function submit() {
    setSubmitting(true);
    setResult(null);

    // Branch routes the Turboly store; WA is the customer identity key.
    if (!branch) { setResult({ ok: false, text: 'Pilih cabang dulu (di bawah).' }); setSubmitting(false); return; }
    if (!waOk) { setResult({ ok: false, text: 'Nomor WhatsApp Indonesia (+62) wajib — mulai 08… atau +62 8…, contoh 08123456789.' }); setSubmitting(false); return; }
    if (!menerima.trim()) { setResult({ ok: false, text: 'Yang menerima (Service Advisor) wajib diisi — Turboly menolak order tanpa advisor.' }); setSubmitting(false); return; }
    if (!effSalesperson) { setResult({ ok: false, text: 'Salesperson wajib dipilih — Turboly menolak order tanpa salesperson.' }); setSubmitting(false); return; }
    if (!alamat.trim()) { setResult({ ok: false, text: 'Alamat wajib diisi (terisi otomatis untuk customer terdaftar).' }); setSubmitting(false); return; }
    const required: Array<[string, string]> = [[noPol, 'No. Polisi'], [nama, 'Nama Customer'], [merk, 'Merek Mobil'], [tipe, 'Tipe'], [warna, 'Warna Mobil'], [km, 'KM'], [tahun, 'Tahun']];
    const missing = required.filter(([v]) => !String(v).trim()).map(([, label]) => label);
    if (missing.length) { setResult({ ok: false, text: `Wajib diisi: ${missing.join(', ')}.` }); setSubmitting(false); return; }
    if (!hargaOk) { setResult({ ok: false, text: 'Harga General Check wajib — angka Rupiah, contoh 100000.' }); setSubmitting(false); return; }

    const estVal = estimasi.trim() === '' ? DEFAULT_ESTIMASI : Number(estimasi.trim());
    const payload = {
      uploadId: uuid(),
      docType: 'CHECK_AND_GO',
      branchCode: branch,
      captureMode: 'typed',
      operatorUserId: menerima || 'unattributed',
      operatorPinVerified: !!menerima,
      deviceBindingVerified: true,
      spkNumber: serial || null,
      capturedAt: new Date().toISOString(),
      customer: { nama, wa: wa || null, alamat: alamat || null },
      vehicle: {
        noPolisi: noPol,
        kind,
        merk: merk || null,
        tipe: tipe || null,
        tahun: tahun ? Number(tahun) : null,
        warna: warna || null,
        km,
      },
      complaint: null,
      estimasiMinutes: Number.isInteger(estVal) && estVal > 0 ? estVal : DEFAULT_ESTIMASI,
      serviceAdvisorName: menerima || null,
      salespersonName: effSalesperson || null,
      harga: hargaVal,
      inspectionItems: insp
        .filter((r) => r.item.trim() !== '')
        .map((r) => ({ item: r.item.trim(), catatan: r.catatan.trim() })),
      signatures: {
        menyerahkanPresent: true,
        menyerahkanNamaJelas: menyerahkan || nama || null,
        menerimaPresent: !!menerima,
        menerimaNamaJelas: menerima || null,
        menyerahkanImage: null,
        menerimaImage: null,
      },
    };

    try {
      // Same outbox as every other intake — see the note in /checkgo.
      const res = await submitOrQueue(payload.uploadId, payload, '/api/checkgo');
      if (res === 'queued') { setResult({ ok: true, text: '✓ Tersimpan offline — akan dikirim otomatis saat online.' }); setSubmitting(false); return; }
      if (res === 'queued_no_images') { setResult({ ok: true, text: '✓ Tersimpan offline (tanda tangan gambar dilepas — penyimpanan penuh). Akan dikirim otomatis saat online.' }); setSubmitting(false); return; }
      if (res === 'lost') { setResult({ ok: false, text: '✗ GAGAL menyimpan: penyimpanan perangkat penuh & tidak ada koneksi. Data TIDAK tersimpan — jangan tutup halaman, hubungkan internet lalu coba lagi.' }); setSubmitting(false); return; }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const notes = (body.findings ?? []).map((f: { message: string }) => f.message).join('; ');
        if (body.needsReview) {
          setResult({ ok: false, text: `Tersimpan, perlu diperbaiki: ${notes}` });
        } else {
          // Straight to the printout — signing happens on paper now.
          router.push(`/checkgo/${body.spkId}/print?print=1`);
          return;
        }
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
            <b>CHECK &amp; GO</b>
            <small>GENERAL CHECK · SAFETY FIRST</small>
          </div>
          <div className="serial">NO. <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="—" /><div className="qr">QR</div></div>
        </div>

        {/* Customer + Vehicle */}
        <div className="two">
          <div className="box">
            <span className="sec-h">INFORMASI CUSTOMER</span>
            <div className="fld"><label>Nomor WhatsApp</label>
              <div>
                <input value={wa} onChange={(e) => setWa(e.target.value)} inputMode="tel" placeholder="Nomor WhatsApp — WAJIB, ketik dulu (08…)" style={!waOk ? { borderColor: '#d97706' } : undefined} />
                {wa.trim() !== '' && !waOk
                  ? <div className="err-inline">⚠ Format Indonesia (+62): mulai 08… atau +62 8…, contoh 08123456789.</div>
                  : waOk ? <div className="ok-inline">✓ +62{waNat}</div> : null}
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
            <div className="fld"><label>No. Polisi</label>
              <div>
                <input value={noPol} onChange={(e) => setNoPol(e.target.value.toUpperCase())} placeholder="B 1234 XYZ" style={plateBad ? { borderColor: '#d97706' } : undefined} />
                {plateBad && <div className="warn-inline">⚠ Format tidak wajar (contoh: B 1234 XYZ) — boleh lanjut.</div>}
                {ownerMismatch && plateOwner && <div className="warn-inline">⚠ Plat milik <b>{plateOwner.nama}</b> ({plateOwner.wa}) — order tetap atas nama pemilik asli; orang di form dicatat sebagai pembawa.</div>}
                {returning && <div className="ok-inline">↩ Pelanggan lama: {returning} — data terisi otomatis.</div>}
              </div>
            </div>
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
                <input list="make-list-cgs" value={merk} onChange={(e) => setMerk(e.target.value)} placeholder="cth: Toyota" style={makeUnknown ? { borderColor: '#d97706' } : undefined} />
                <datalist id="make-list-cgs">{makes.map((m) => <option key={m} value={m} />)}</datalist>
                {makeUnknown && <div className="warn-inline">⚠ Merk tidak ada di katalog Turboly — periksa ejaan.</div>}
              </div>
            </div>
            <div className="fld"><label>Tipe</label>
              <div>
                <input list="model-list-cgs" value={tipe} onChange={(e) => setTipe(e.target.value)} placeholder={models.length ? 'pilih dari daftar / ketik' : 'cth: Avanza'} style={modelUnknown ? { borderColor: '#d97706' } : undefined} />
                <datalist id="model-list-cgs">{models.map((m) => <option key={m} value={m} />)}</datalist>
                {modelUnknown && <div className="warn-inline">⚠ Tipe tidak ada di daftar model {merk.trim().toUpperCase()} — dipetakan ke model paling mirip saat kirim.</div>}
              </div>
            </div>
            <div className="fld"><label>Tahun/Warna</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input value={tahun} onChange={(e) => setTahun(e.target.value)} inputMode="numeric" placeholder="2019" />
                <input value={warna} onChange={(e) => setWarna(e.target.value)} placeholder="Warna" />
              </div>
            </div>
            <div className="fld"><label>KM</label>
              <div>
                <input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" placeholder="45.230" style={kmBelowPrev ? { borderColor: '#d97706' } : undefined} />
                {kmBelowPrev && <div className="warn-inline">⚠ KM LEBIH KECIL dari kunjungan sebelumnya ({Number(prevVisitKm).toLocaleString('id-ID')}) — boleh lanjut.</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Pekerjaan: fixed General Check line */}
        <div className="box" style={{ marginTop: 8 }}>
          <span className="sec-h">PEKERJAAN</span>
          <div className="fld" style={{ gridTemplateColumns: '1fr 130px 110px' }}>
            <label style={{ fontWeight: 700 }}>GENERAL CHECK (JAS-NAWJAS-GC) — 1×</label>
            <div>
              <input value={harga} onChange={(e) => setHarga(e.target.value)} inputMode="numeric" placeholder="Harga (Rp)" style={!hargaOk ? { borderColor: '#d97706' } : undefined} />
            </div>
            <div>
              <input value={estimasi} onChange={(e) => setEstimasi(e.target.value)} inputMode="numeric" placeholder="Estimasi (menit)" />
            </div>
          </div>
          {hargaOk
            ? <div className="ok-inline">✓ Rp {hargaVal.toLocaleString('id-ID')} (termasuk pajak) · estimasi {estimasi.trim() || DEFAULT_ESTIMASI} menit</div>
            : <div className="err-inline">⚠ Harga wajib — angka Rupiah, contoh 100000 (default Rp 100.000).</div>}
        </div>

        {/* Pemeriksaan detail (opsional) */}
        <div className="box" style={{ marginTop: 8 }}>
          <span className="sec-h">PEMERIKSAAN DETAIL (OPSIONAL)</span>
          <div style={{ fontSize: 9.5, color: '#33415c', marginBottom: 4 }}>
            Kosong = satu pemeriksaan umum &quot;Check and Go&quot;. Tambah baris untuk item spesifik (mis. sistem pendingin, tutup radiator).
          </div>
          {insp.map((r, i) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '18px 1fr 1fr 26px', gap: 4, alignItems: 'center', margin: '3px 0' }}>
              <span style={{ fontSize: 10, textAlign: 'center', color: '#33415c' }}>{i + 1}</span>
              <input value={r.item} onChange={(e) => setInspRow(r.id, { item: e.target.value })} placeholder="Item — mis. Sistem pendingin" />
              <input value={r.catatan} onChange={(e) => setInspRow(r.id, { catatan: e.target.value })} placeholder="Catatan (opsional)" />
              <button type="button" className="warn-btn" style={{ borderColor: '#dc2626', color: '#b3261e', padding: '2px 6px' }} onClick={() => delInsp(r.id)} title="Hapus baris">✕</button>
            </div>
          ))}
          <button type="button" className="warn-btn" style={{ marginTop: 4, borderColor: '#b9c6de', color: '#33415c' }} onClick={addInsp}>+ Tambah item pemeriksaan</button>
        </div>

        {/* Authorization + signatures */}
        <div className="auth">
          Saya yang bertanda tangan di bawah ini menyetujui pengecekan kendaraan (General Check) oleh bengkel NAWILIS sesuai order di atas, termasuk test jalan apabila diperlukan. Bila ditemukan masalah, perbaikan hanya dilakukan setelah persetujuan customer.
        </div>
        <div className="sign">
          <div className="b">Yang menyerahkan (customer),
            <div style={{ height: 56, border: '1px dashed #9fb2d4', borderRadius: 6, display: 'grid', placeItems: 'center', color: '#8a99b8', fontSize: 11, margin: '4px 0' }}>tanda tangan di formulir cetak</div>
            <input value={menyerahkan} onChange={(e) => setMenyerahkan(e.target.value)} placeholder="Nama jelas" />
          </div>
          <div className="b">Yang menerima (Service Advisor),
            <div style={{ height: 56, border: '1px dashed #9fb2d4', borderRadius: 6, display: 'grid', placeItems: 'center', color: '#8a99b8', fontSize: 11, margin: '4px 0' }}>tanda tangan di formulir cetak</div>
            <input
              list="advisor-list-cgs"
              value={menerima}
              onChange={(e) => setMenerima(e.target.value)}
              placeholder={advisors.length ? 'Pilih dari daftar atau ketik nama — WAJIB' : (branch ? 'Nama jelas — WAJIB' : 'Pilih cabang dulu / ketik nama')}
              style={!menerima.trim() ? { borderColor: '#d97706' } : undefined}
            />
            <datalist id="advisor-list-cgs">
              {advisors.map((a) => <option key={a.code} value={a.name} />)}
            </datalist>
            {!menerima.trim() && <div className="err-inline">⚠ Wajib — Turboly menolak order tanpa advisor.</div>}
            {advisorUnknown && <div className="warn-inline">⚠ Nama tidak ada di daftar advisor cabang ini — harus sama persis dengan nama di Turboly.</div>}
            {/* Turboly requires a Salesperson too, from its own per-store list. */}
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
          </div>
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
          {submitting ? 'Menyimpan…' : `Simpan Check & Go${hargaOk ? ` — Rp ${hargaVal.toLocaleString('id-ID')}` : ''}`}
        </button>
        <a className="btn ghost" href="/checkgo">Form cepat</a>
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
