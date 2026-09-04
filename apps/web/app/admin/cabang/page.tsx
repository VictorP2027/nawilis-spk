'use client';

import { useState } from 'react';
import BrandMark from '../../components/BrandMark';

/**
 * /admin/cabang — open a branch without a GitHub account.
 *
 * A branch opens a few times a year, and until now it took repo access:
 * giving someone that to run one workflow also gives them the pusher and the
 * code. This page sits behind the staff login everyone already uses, and can
 * do exactly one thing.
 *
 * Its own route on purpose — /admin is untouched, so nothing that page does
 * today can be affected by this existing.
 */

type Result =
  | { kind: 'ok'; code: string; name: string; runsUrl: string; resuming: boolean; dryRun: boolean }
  | { kind: 'err'; error: string; hint?: string };

export default function TambahCabang(): React.ReactElement {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [store, setStore] = useState('');
  const [type, setType] = useState('NAWILIS');
  const [abbrev, setAbbrev] = useState('');
  const [noTurboly, setNoTurboly] = useState(false);
  const [dryRun, setDryRun] = useState(true); // rehearse by default: the code is permanent
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const codeOk = /^[A-Z0-9-]{3,12}$/.test(code.trim().toUpperCase());
  const storeOk = noTurboly || store.trim() !== '';
  const canSubmit = codeOk && name.trim() !== '' && storeOk && !busy;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/admin/branch-add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          name: name.trim(),
          store: store.trim(),
          type,
          abbrev: abbrev.trim().toUpperCase(),
          no_turboly: noTurboly,
          dry_run: dryRun,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, string>;
      if (r.ok) {
        setResult({ kind: 'ok', code: d.code ?? code, name: d.name ?? name, runsUrl: d.runsUrl ?? '', resuming: Boolean(d.resuming), dryRun: Boolean(d.dryRun) });
        setCode(''); setName(''); setStore(''); setAbbrev(''); setNoTurboly(false);
      } else {
        setResult({ kind: 'err', error: d.error ?? `Gagal (HTTP ${r.status}).`, hint: d.hint });
      }
    } catch {
      setResult({ kind: 'err', error: 'Jaringan bermasalah — coba lagi.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <BrandMark page="Cabang" />
        <a className="branch" href="/admin" style={{ textDecoration: 'none' }}>← Dashboard</a>
      </div>

      <div className="wrap">
        <div className="card">
          <div className="label">Kode cabang</div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="NWL-JKT"
            style={code.trim() !== '' && !codeOk ? { borderColor: '#dc2626' } : undefined}
          />
          {code.trim() !== '' && !codeOk && (
            <div className="req-note">⚠ huruf besar, angka dan tanda hubung saja (3–12), mis. NWL-JKT</div>
          )}
          <div className="warn-note" style={{ background: '#eef2ff', borderColor: '#c7d2fe', color: '#3730a3' }}>
            Kode ini <b>permanen</b>. Semua SPK cabang ini tercatat di bawahnya selamanya.
          </div>

          <div className="label" style={{ marginTop: 12 }}>Nama cabang</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jakarta Kota" />
          <div className="hint" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.45 }}>Ini yang dilihat kasir di pilihan cabang. Boleh diganti kapan saja.</div>

          <div className="label" style={{ marginTop: 12 }}>Nama store di Turboly</div>
          <input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            placeholder="Nawilis Jakarta Kota"
            disabled={noTurboly}
            style={!storeOk ? { borderColor: '#dc2626' } : undefined}
          />
          <div className="hint" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.45 }}>
            Salin <b>persis</b> dari dropdown Store di Turboly. Kalau salah, prosesnya berhenti dan
            mencetak daftar nama store yang benar — tidak ada yang rusak.
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14 }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} style={{ width: 18, marginTop: 3 }} />
            <span style={{ fontSize: 14 }}>
              <b>Uji coba dulu</b> — jalankan semuanya, tapi jangan tulis apa pun
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>
                Kode cabang itu permanen dan tidak bisa dihapus. Uji coba memastikan nama store-nya
                benar dan advisornya terbaca, sebelum cabangnya betul-betul dibuka.
              </span>
            </span>
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
            <input type="checkbox" checked={noTurboly} onChange={(e) => setNoTurboly(e.target.checked)} style={{ width: 18, marginTop: 3 }} />
            <span style={{ fontSize: 14 }}>
              Store-nya belum dibuat di Turboly
              <span style={{ display: "block", fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.45 }}>
                Cabangnya tetap muncul di form, tapi SPK-nya tertahan sampai store Turboly ada.
              </span>
            </span>
          </label>

          <div className="label" style={{ marginTop: 12 }}>Jenis cabang</div>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="NAWILIS">NAWILIS</option>
            <option value="QUICKSERV">QUICKSERV</option>
            <option value="COMPANY">COMPANY</option>
          </select>

          <div className="label" style={{ marginTop: 12 }}>Singkatan nomor dokumen (opsional)</div>
          <input value={abbrev} onChange={(e) => setAbbrev(e.target.value.toUpperCase())} placeholder="JKT" />
          <div className="hint" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.45 }}>Yang muncul di nomor Turboly, mis. SRO/JKT/26090123.</div>
        </div>

        <button className="btn primary" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Mengirim…' : dryRun ? 'Uji coba (tidak menulis apa pun)' : 'Buka cabang ini'}
        </button>

        {result?.kind === 'ok' && (
          <div className="card">
            <div className="ok-note">
              {result.dryRun ? '🧪 UJI COBA' : '⏳ Permintaan'} untuk <b>{result.name}</b> ({result.code}) sudah dikirim
              {result.resuming ? ' (melanjutkan cabang yang belum selesai)' : ''}. Sekitar 1 menit.
            </div>
            {/* Deliberately not "selesai": all that happened is that the run was
                accepted. It can still stop — a store name that does not match
                Turboly is the common one — and saying "sudah dibuka" here would
                send someone off believing a branch exists when it does not. */}
            <div style={{ fontSize: 14, marginTop: 10, lineHeight: 1.5 }}>
              Prosesnya: cabang masuk daftar form → dipetakan ke store Turboly → advisor cabang disalin.
              <b> Belum tentu berhasil</b> — kalau nama store tidak cocok, prosesnya berhenti dan
              mencetak daftar nama store yang benar.
            </div>
            <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
              Cek hasilnya di tautan di bawah, lalu muat ulang form SPK.
            </div>
            {result.runsUrl && (
              <div style={{ marginTop: 10 }}>
                <a href={result.runsUrl} target="_blank" rel="noreferrer">Lihat prosesnya di GitHub →</a>
              </div>
            )}
          </div>
        )}

        {result?.kind === 'err' && (
          <div className="card">
            <div className="finding BLOCK">{result.error}</div>
            {result.hint && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.45 }}>{result.hint}</div>}
          </div>
        )}

        <div className="sync" style={{ marginTop: 12, textAlign: 'center', color: 'var(--muted)' }}>
          Cabang lama tidak bisa diubah dari sini — hanya menambah.
        </div>
      </div>
    </>
  );
}
