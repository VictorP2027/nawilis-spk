'use client';

import { useState, type CSSProperties } from 'react';

/**
 * A text input whose suggestions are an ON-SCREEN scrollable list, not a
 * <datalist>. iOS renders datalists only as keyboard-bar autocomplete —
 * three cramped entries above the keys (Victor's screenshot, 2026-08-13) —
 * so the jasa/advisor/merk pickers were invisible on the phones the forms
 * actually run on. Same look and behaviour as ProductInput: open on focus,
 * type to filter (every term must match, case-insensitive), tap to pick,
 * free text always allowed.
 */
export function SuggestInput({
  options,
  value,
  onChange,
  placeholder,
  style,
  inputMode,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  inputMode?: 'text' | 'search';
}) {
  const [open, setOpen] = useState(false);
  const terms = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = terms.length
    ? options.filter((o) => { const l = o.toLowerCase(); return terms.every((t) => l.includes(t)); })
    : options;

  return (
    <span style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      <input
        value={value}
        // Typing reopens the list — same lesson as ProductInput: a pick keeps
        // the input focused, so no new focus event would ever reopen it.
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        // Blur fires before an option's click would — mousedown on the list
        // runs first, so picking works; anywhere else closes it.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        autoCorrect="off"
        spellCheck={false}
        inputMode={inputMode}
        style={{ ...style, width: '100%' }}
      />
      {open && shown.length > 0 && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
            maxHeight: 220, overflowY: 'auto', background: '#fff',
            border: '1px solid var(--line, #cbd5e1)', borderRadius: 8,
            boxShadow: '0 8px 20px rgba(15,23,42,.15)', marginTop: 2,
          }}
        >
          {shown.slice(0, 200).map((o) => (
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
