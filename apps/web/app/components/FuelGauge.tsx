'use client';

/**
 * Fuel / EV-battery indicator for the SPK intake — the hand-drawn spec: a
 * blocked bar with 0·25·50·75·100% marks, tap a block to fill up to it, or
 * flip to EV and type the battery percentage. `pct === null` means UNANSWERED,
 * which is different from an answered empty tank (0%) — tapping the first
 * block twice reaches 0. One of the two modes must carry a value; the forms
 * gate submit on that.
 */
export function FuelGauge(props: {
  mode: 'fuel' | 'ev';
  pct: number | null;
  ev: string;
  onMode: (m: 'fuel' | 'ev') => void;
  onPct: (p: number | null) => void;
  onEv: (v: string) => void;
}) {
  const { mode, pct, ev, onMode, onPct, onEv } = props;
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
          <div style={{ display: 'flex', fontSize: 10, color: 'var(--muted, #667)' }}>
            {[0, 25, 50, 75].map((m) => (
              <span key={m} style={{ flex: 1 }}>{m}</span>
            ))}
            <span>100%</span>
          </div>
          <div style={{ display: 'flex', border: '1.5px solid var(--nawilis, #0a3d8f)', borderRadius: 4, overflow: 'hidden', height: 34 }}>
            {[25, 50, 75, 100].map((v) => {
              const filled = pct !== null && pct >= v;
              return (
                <button
                  key={v}
                  type="button"
                  aria-label={`isi sampai ${v}%`}
                  // Tapping the current top block steps DOWN one — that is how 0
                  // (an answered empty tank) is reachable at all.
                  onClick={() => onPct(pct === v ? v - 25 : v)}
                  style={{
                    flex: 1, border: 'none', cursor: 'pointer', padding: 0,
                    borderLeft: v > 25 ? '1px solid var(--nawilis, #0a3d8f)' : 'none',
                    background: filled ? 'var(--nawilis, #0a3d8f)' : '#fff',
                  }}
                />
              );
            })}
          </div>
          <div style={{ fontSize: 12, marginTop: 2, fontWeight: 700, color: pct === null ? '#dc2626' : '#14213d' }}>
            {pct === null ? 'ketuk balok untuk mengisi' : `${pct}%`}
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
