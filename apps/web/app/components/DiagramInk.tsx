'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface InkHandle {
  /** Transparent PNG data URL when something was drawn, else null. */
  get: () => string | null;
  clear: () => void;
}

/**
 * Freehand annotation layer for the body diagram — the signature pad's canvas
 * mechanics (DPR-crisp, one pointer, resize-rescale) reborn as a TRANSPARENT
 * overlay: it sits exactly on top of the diagram SVG, draws in red so hand
 * marks read as annotation against the blue zones, and its PNG keeps the
 * transparency so the printout can lay it back over the same diagram.
 *
 * `active` gates everything: when false the layer ignores pointers entirely,
 * so zone-tapping underneath keeps working; when true it captures them, so a
 * scroll-swipe cannot paint a stray line while the operator meant to draw.
 */
export const DiagramInk = forwardRef<InkHandle, { active: boolean; onInk?: (has: boolean) => void }>(
  function DiagramInk({ active, onInk }, ref) {
    const cv = useRef<HTMLCanvasElement>(null);
    const inked = useRef(false);
    const pathLen = useRef(0);
    const activePtr = useRef<number | null>(null);
    const last = useRef<{ x: number; y: number } | null>(null);

    const fit = () => {
      const c = cv.current;
      if (!c || !c.offsetWidth) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.round(c.offsetWidth * dpr);
      const h = Math.round(c.offsetHeight * dpr);
      if (c.width === w && c.height === h) return;
      let snap: HTMLCanvasElement | null = null;
      if (inked.current && c.width > 0) {
        snap = document.createElement('canvas');
        snap.width = c.width; snap.height = c.height;
        snap.getContext('2d')!.drawImage(c, 0, 0);
      }
      c.width = w; c.height = h;
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.lineWidth = 2.5;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#dc2626';
      if (snap) g.drawImage(snap, 0, 0, snap.width, snap.height, 0, 0, c.offsetWidth, c.offsetHeight);
    };
    useEffect(() => {
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(cv.current!);
      return () => ro.disconnect();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const doClear = () => {
      const c = cv.current;
      if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
      inked.current = false;
      pathLen.current = 0;
      activePtr.current = null;
      onInk?.(false);
    };
    useImperativeHandle(ref, () => ({
      get: () => (inked.current && cv.current ? cv.current.toDataURL('image/png') : null),
      clear: doClear,
    }));

    const pos = (e: React.PointerEvent) => {
      const r = cv.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const end = (e: React.PointerEvent) => {
      if (e.pointerId !== activePtr.current) return;
      activePtr.current = null;
      last.current = null;
    };
    return (
      <canvas
        ref={cv}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          pointerEvents: active ? 'auto' : 'none',
          touchAction: active ? 'none' : 'auto',
          cursor: active ? 'crosshair' : 'default',
        }}
        onPointerDown={(e) => {
          if (!active || activePtr.current !== null) return;
          e.preventDefault();
          cv.current!.setPointerCapture(e.pointerId);
          activePtr.current = e.pointerId;
          last.current = pos(e);
        }}
        onPointerMove={(e) => {
          if (!active || e.pointerId !== activePtr.current || !last.current) return;
          const p = pos(e);
          const g = cv.current!.getContext('2d')!;
          g.beginPath();
          g.moveTo(last.current.x, last.current.y);
          g.lineTo(p.x, p.y);
          g.stroke();
          pathLen.current += Math.hypot(p.x - last.current.x, p.y - last.current.y);
          last.current = p;
          if (!inked.current && pathLen.current > 12) { inked.current = true; onInk?.(true); }
        }}
        onPointerUp={end}
        onPointerCancel={end}
      />
    );
  },
);
