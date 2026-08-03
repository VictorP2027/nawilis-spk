'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface SigHandle {
  /** PNG data URL when something was drawn, else null. */
  get: () => string | null;
  clear: () => void;
}

/**
 * On-glass signature pad. Armed by an explicit tap (so a scroll swipe over the
 * pad can never paint a stray "signature"); tracks ONE pointer (palm/second
 * finger ignored); DPR-crisp; survives rotation/resize by rescaling the ink.
 */
export const SignaturePad = forwardRef<SigHandle>(function SignaturePad(_props, ref) {
  const cv = useRef<HTMLCanvasElement>(null);
  const inked = useRef(false);
  const pathLen = useRef(0); // require real movement before counting as signed
  const activePtr = useRef<number | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [armed, setArmed] = useState(false);

  // Size the backing store to CSS size × devicePixelRatio; on any resize
  // (rotation, split-screen) re-fit and rescale the existing ink so strokes
  // always land under the finger.
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
      snap.width = c.width;
      snap.height = c.height;
      snap.getContext('2d')!.drawImage(c, 0, 0);
    }
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#1a2b6d';
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
    setHasInk(false);
  };

  useImperativeHandle(ref, () => ({
    get: () => (inked.current && cv.current ? cv.current.toDataURL('image/png') : null),
    clear: doClear,
  }));

  const pos = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const endStroke = (e: React.PointerEvent) => {
    if (e.pointerId !== activePtr.current) return; // palm lift must not cut the pen stroke
    activePtr.current = null;
    last.current = null;
  };
  return (
    <div className="sigpad">
      <canvas
        ref={cv}
        style={{ touchAction: armed ? 'none' : 'auto' }}
        onPointerDown={(e) => {
          if (!armed || activePtr.current !== null) return; // one pointer draws; palm ignored
          e.preventDefault();
          cv.current!.setPointerCapture(e.pointerId);
          activePtr.current = e.pointerId;
          last.current = pos(e);
        }}
        onPointerMove={(e) => {
          if (!armed || e.pointerId !== activePtr.current || !last.current) return;
          const p = pos(e);
          const g = cv.current!.getContext('2d')!;
          g.beginPath();
          g.moveTo(last.current.x, last.current.y);
          g.lineTo(p.x, p.y);
          g.stroke();
          pathLen.current += Math.hypot(p.x - last.current.x, p.y - last.current.y);
          last.current = p;
          // A dot or micro-smudge is not a signature — require real ink.
          if (!inked.current && pathLen.current > 12) { inked.current = true; setHasInk(true); }
        }}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />
      {!armed && (
        <button type="button" className="sig-arm" onClick={() => setArmed(true)}>✍ Ketuk untuk tanda tangan</button>
      )}
      {armed && (hasInk
        ? <button type="button" className="sig-clr" onClick={doClear}>✕ Hapus</button>
        : <span className="sig-hint">✍ tanda tangan di sini</span>)}
    </div>
  );
});
