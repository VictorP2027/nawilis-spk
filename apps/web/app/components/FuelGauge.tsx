'use client';

import { useRef } from 'react';
import { fuelWord, FRACTIONS, STEPS } from '../../lib/fuel';

/**
 * Fuel / EV-battery indicator for the SPK intake — a blocked bar read the way a
 * dashboard gauge is read: E · ¼ · ½ · ¾ · F. Nobody looks at a fuel needle and
 * sees "25%", so the bar names fractions and the percentage is gone from the face
 * of it — here and on both printouts.
 *
 * Tap or drag anywhere along the bar; a tank is rarely on a quarter exactly. The
 * value is still a 0–100 number in the document, so nothing downstream changes.
 * `pct === null` means UNANSWERED, which is different from an answered empty tank
 * — the far left of the bar is E, and it is a real answer. EV keeps a real
 * percentage, because a battery genuinely is one.
 */
/**
 * The words and marks live in lib/fuel.ts, NOT here: the print renderers need
 * them too, and one of those runs on the server — a client module cannot be
 * called from there. Re-exported so existing client imports keep working.
 */
export { fuelWord, FRACTIONS, STEPS, STEP_WORDS } from '../../lib/fuel';

export function FuelGauge(props: {
  mode: 'fuel' | 'ev';
  pct: number | null;
  ev: string;
  onMode: (m: 'fuel' | 'ev') => void;
  onPct: (p: number | null) => void;
  onEv: (v: string) => void;
}) {
  const { mode, pct, ev, onMode, onPct, onEv } = props;
  const track = useRef<HTMLDivElement>(null);
  // Where the finger is on the bar, snapped to the nearest eighth.
  const setFromPointer = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onPct(STEPS[Math.round(ratio * (STEPS.length - 1))]!);
  };
  const answered = mode === 'fuel' ? pct !== null : /^\d{1,3}$/.test(ev.trim()) && Number(ev) <= 100;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="label" style={{ marginBottom: 0 }}>
          {mode === 'fuel' ? 'Bahan Bakar' : 'Baterai EV'} — WAJIB
        </span>
        <button
          type="button"
          className="chk-chip"
          onClick={() => { onMode(mode === 'fuel' ? 'ev' : 'fuel'); }}
          title="Mobil listrik? Catat sisa baterai sebagai angka."
        >
          {mode === 'fuel' ? '⚡ mobil listrik (EV)?' : '⛽ kembali ke BBM'}
        </button>
        {!answered && <span className="req-note" style={{ marginTop: 0 }}>⚠ wajib diisi</span>}
      </div>
      {mode === 'fuel' ? (
        <div style={{ maxWidth: 340, marginTop: 6 }}>
          <div style={{ display: 'flex', fontSize: 11, fontWeight: 700, color: 'var(--muted, #667)' }}>
            {[0, 25, 50, 75].map((m) => (
              <span key={m} style={{ flex: 1 }}>{FRACTIONS[m]}</span>
            ))}
            <span>{FRACTIONS[100]}</span>
          </div>
          <div
            ref={track}
            role="slider"
            tabIndex={0}
            aria-label="Sisa bahan bakar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
            aria-valuetext={pct === null ? 'belum diisi' : fuelWord(pct)}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setFromPointer(e.clientX); }}
            onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromPointer(e.clientX); }}
            onKeyDown={(e) => {
              const at = STEPS.indexOf((pct ?? 0) as (typeof STEPS)[number]);
              const here = at < 0 ? 0 : at;
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onPct(STEPS[Math.min(STEPS.length - 1, here + 1)]!); }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onPct(STEPS[Math.max(0, here - 1)]!); }
              if (e.key === 'Home') { e.preventDefault(); onPct(0); }
              if (e.key === 'End') { e.preventDefault(); onPct(100); }
            }}
            style={{
              position: 'relative', border: '1.5px solid var(--nawilis, #0a3d8f)', borderRadius: 4,
              overflow: 'hidden', height: 34, background: '#fff', cursor: 'pointer', touchAction: 'none',
            }}
          >
            <div style={{ position: 'absolute', inset: 0, width: `${pct ?? 0}%`, background: 'var(--nawilis, #0a3d8f)' }} />
            {[25, 50, 75].map((mk) => (
              <span key={mk} style={{ position: 'absolute', top: 0, bottom: 0, left: `${mk}%`, width: 1, background: 'var(--nawilis, #0a3d8f)', opacity: 0.55 }} />
            ))}
          </div>
          <div style={{ fontSize: 12, marginTop: 2, fontWeight: 700, color: pct === null ? '#dc2626' : '#14213d' }}>
            {pct === null ? 'ketuk atau geser bar untuk mengisi' : fuelWord(pct)}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <input
            value={ev}
            onChange={(e) => onEv(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            inputMode="numeric"
            placeholder="sisa baterai"
            style={{ width: 110, fontSize: 16, padding: '6px 8px', ...(answered ? {} : { borderColor: '#dc2626' }) }}
          />
          <span style={{ fontWeight: 700 }}>%</span>
        </div>
      )}
    </div>
  );
}
