'use client';

import { useEffect, useState } from 'react';
import { BRANCHES } from './refdata.client';

type Branch = { code: string; name: string; type: string };

const CACHE_KEY = 'spk.branches.v1';

/**
 * The branch list a form should render.
 *
 * Starts as the compiled-in list — synchronously, so the picker is never empty
 * and the form is usable the moment it opens, network or not. Then a branch
 * added since the last deploy arrives from /api/branches, and is kept in
 * localStorage so the NEXT load shows it even with no signal: a new counter is
 * exactly the place most likely to be working off a phone hotspot.
 *
 * A failed fetch is silent by design. The fallback is the list the app shipped
 * with, which is right for all 27 existing branches.
 */
export function useBranches(): ReadonlyArray<Branch> {
  // Always the compiled-in list for the FIRST client render, so it matches the
  // server-rendered HTML exactly. Seeding from localStorage here instead would
  // hydrate a different list than the server sent the moment a branch has been
  // added — React then discards the markup and warns. The cache is applied in
  // the effect below, one paint later, which is invisible in practice.
  const [branches, setBranches] = useState<ReadonlyArray<Branch>>(BRANCHES);

  useEffect(() => {
    let live = true;
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as Branch[];
        if (Array.isArray(cached) && cached.length) setBranches(cached);
      }
    } catch { /* private mode / cleared storage — the compiled list is fine */ }
    fetch('/api/branches', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { branches?: Branch[] } | null) => {
        if (!live || !d?.branches?.length) return;
        setBranches(d.branches);
        try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(d.branches)); } catch { /* not fatal */ }
      })
      .catch(() => { /* offline: keep what we have */ });
    return () => { live = false; };
  }, []);

  return branches;
}
