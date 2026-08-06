'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * A text input with live product suggestions from /api/products.
 *
 * Native <datalist>: typing stays free-form — the sheet's Merk/SAE and
 * "Merk dan ukuran" boxes accept whatever the checker wrote — but two
 * characters in, the real tenant catalog (scraped from Turboly) starts
 * offering itself. Picking a suggestion is a convenience, never a constraint:
 * the stored value is still just the text.
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
  const listId = useId();
  const [opts, setOpts] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) { setOpts([]); return; }
    if (timer.current) clearTimeout(timer.current);
    let live = true;
    timer.current = setTimeout(() => {
      fetch(`/api/products?cat=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d: { products?: Array<{ name: string; brand: string | null }> }) => {
          if (live) setOpts((d.products ?? []).map((p) => p.name));
        })
        .catch(() => undefined);
    }, 250);
    return () => { live = false; if (timer.current) clearTimeout(timer.current); };
  }, [cat, value]);

  return (
    <>
      <input list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={style} />
      <datalist id={listId}>
        {opts.map((o) => <option key={o} value={o} />)}
      </datalist>
    </>
  );
}
