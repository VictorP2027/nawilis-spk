'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A text input that behaves like the SKU dropdown next to it: TAP it and the
 * whole catalog opens in a visible list underneath — no typing required, no
 * hidden autocomplete (datalist is exactly that, and iPad Safari barely shows
 * it, which is how "where are the 252 oils?" happened). Typing filters the
 * list server-side; tapping a row fills the box; free text is still accepted
 * unchanged — the catalog offers, never constrains.
 */
export function ProductInput({
  cat,
  value,
  onChange,
  placeholder,
  style,
}: {
  /** tb_products category: OLM | ATF | BAN | BUSI | COOLANT | KANVAS_REM | MINYAK_REM */
  cat: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [opts, setOpts] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = value.trim();
    if (timer.current) clearTimeout(timer.current);
    let live = true;
    // Empty box = the whole category (300 covers every category except the
    // 3.3k tires, which narrow as the user types — server-side, every term
    // must match, so "brid 185" still finds the Bridgestone 185s).
    timer.current = setTimeout(() => {
      fetch(`/api/products?cat=${encodeURIComponent(cat)}${q ? `&q=${encodeURIComponent(q)}` : '&limit=300'}`)
        .then((r) => r.json())
        .then((d: { products?: Array<{ name: string; brand: string | null }> }) => {
          if (live) setOpts((d.products ?? []).map((p) => p.name));
        })
        .catch(() => undefined);
    }, q ? 250 : 0);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [cat, value]);

  return (
    <span style={{ position: 'relative', display: 'inline-block', ...(style?.width ? { width: style.width } : { width: '100%' }) }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        // Blur fires before an option's click would — mousedown on the list
        // runs first, so picking works; anywhere else closes it.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        style={{ ...style, width: '100%' }}
      />
      {open && opts.length > 0 && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
            maxHeight: 220, overflowY: 'auto', background: '#fff',
            border: '1px solid var(--line, #cbd5e1)', borderRadius: 8,
            boxShadow: '0 8px 20px rgba(15,23,42,.15)', marginTop: 2,
          }}
        >
          {opts.map((o) => (
            <div
              key={o}
              onMouseDown={(e) => { e.preventDefault(); onChange(o); setOpen(false); }}
              style={{ padding: '8px 10px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f1f5f9', textAlign: 'left' }}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
