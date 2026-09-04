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
  const [branches, setBranches] = useState<ReadonlyArray<Branch>>(() => {
    if (typeof window === 'undefined') return BRANCHES;
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as Branch[];
        if (Array.isArray(cached) && cached.length) return cached;
      }
    } catch { /* private mode / cleared storage — the compiled list is fine */ }
    return BRANCHES;
  });

  useEffect(() => {
    let live = true;
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
