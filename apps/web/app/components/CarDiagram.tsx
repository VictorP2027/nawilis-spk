'use client';

/**
 * The printed SPK's body diagram, redrawn line-for-line from the paper form:
 * detached bumper bars, LAMBANG bars with the L/R medallions, trapezoid grill
 * and bonnet with their corner diagonals, the windshield/rear-glass trapezoids,
 * four PINTU panels around the stacked KACA panes and the ATAP, the beltline
 * with its LIST ticks, wheels with hub and bolt circles outside the body, and
 * the BAN→VELG callout. Static art — annotation happens in ink on the
 * DiagramInk layer above it, exactly like a pen on the paper.
 */
export function CarDiagram(props: { width?: number | string }) {
  const bolt = (cx: number, cy: number) => (
    <g key={`${cx}-${cy}`}>
      <circle cx={cx} cy={cy} r={27} fill="none" stroke="#333" strokeWidth="1.4" />
      <circle cx={cx} cy={cy} r={21} fill="none" stroke="#333" strokeWidth="0.8" />
      <circle cx={cx} cy={cy} r={10} fill="none" stroke="#333" strokeWidth="1" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <circle key={a} cx={cx + 5.5 * Math.cos((a * Math.PI) / 180)} cy={cy + 5.5 * Math.sin((a * Math.PI) / 180)} r={1.6} fill="#333" />
      ))}
      <circle cx={cx} cy={cy} r={1.8} fill="#333" />
    </g>
  );
  const T = (x: number, y: number, s: string, size = 9, rot?: number) => (
    <text x={x} y={y} textAnchor="middle" fontSize={size} fill="#333" transform={rot ? `rotate(${rot} ${x} ${y})` : undefined}>{s}</text>
  );
  return (
    <svg viewBox="0 0 360 520" style={{ display: 'block', width: props.width ?? '100%' }}>
      {/* bumpers — detached bars like the paper */}
      <rect x={78} y={12} width={204} height={11} fill="none" stroke="#333" />
      {T(180, 20.5, 'BUMPER')}
      <rect x={78} y={497} width={204} height={11} fill="none" stroke="#333" />
      {T(180, 505.5, 'BUMPER')}

      {/* lambang bars with L / R medallions */}
      <rect x={100} y={29} width={160} height={11} fill="none" stroke="#333" />
      {T(180, 37.5, 'LAMBANG DEPAN', 8)}
      <circle cx={108} cy={34.5} r={7} fill="#fff" stroke="#333" />{T(108, 37, 'L', 7)}
      <circle cx={252} cy={34.5} r={7} fill="#fff" stroke="#333" />{T(252, 37, 'R', 7)}
      <rect x={100} y={478} width={160} height={11} fill="none" stroke="#333" />
      {T(180, 486.5, 'LAMBANG BELAKANG', 8)}
      <circle cx={108} cy={483.5} r={7} fill="#fff" stroke="#333" />{T(108, 486, 'L', 7)}
      <circle cx={252} cy={483.5} r={7} fill="#fff" stroke="#333" />{T(252, 486, 'R', 7)}

      {/* wheels, outside the body */}
      {bolt(46, 84)}{bolt(314, 84)}{bolt(46, 438)}{bolt(314, 438)}

      {/* BAN → VELG callout, as printed */}
      {T(336, 116, 'BAN', 8)}
      <path d="M 330 112 L 322 100" stroke="#333" fill="none" markerEnd="url(#arr)" />
      {T(340, 134, 'VELG', 8)}
      <path d="M 332 130 L 320 92" stroke="#333" fill="none" markerEnd="url(#arr)" />
      <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#333" /></marker></defs>

      {/* body outline with wheel-arch indents */}
      <path
        d="M 108 42 L 252 42 L 276 120 L 284 170 L 284 400 L 276 452 L 252 474 L 108 474 L 84 452 L 76 400 L 76 170 L 84 120 Z"
        fill="none" stroke="#333" strokeWidth="1.4"
      />
      {/* spakbor strips + vertical labels */}
      <path d="M 84 120 L 108 42" stroke="#333" fill="none" strokeWidth="0.8" />
      <path d="M 276 120 L 252 42" stroke="#333" fill="none" strokeWidth="0.8" />
      {T(90, 88, 'SPAKBOR', 7, -78)}
      {T(270, 88, 'SPAKBOR', 7, 78)}
      <path d="M 84 452 L 108 474" stroke="#333" fill="none" strokeWidth="0.8" />
      <path d="M 276 452 L 252 474" stroke="#333" fill="none" strokeWidth="0.8" />
      {T(90, 432, 'SPAKBOR', 7, -102)}
      {T(270, 432, 'SPAKBOR', 7, 102)}

      {/* grill + bonnet trapezoids, with the corner diagonals */}
      <polygon points="150,48 210,48 218,66 142,66" fill="none" stroke="#333" />
      {T(180, 60, 'GRILL', 8)}
      <polygon points="142,68 218,68 230,112 130,112" fill="none" stroke="#333" />
      {T(180, 93, 'KAP MESIN', 8)}
      <line x1={115} y1={42} x2={150} y2={48} stroke="#333" strokeWidth="0.8" />
      <line x1={245} y1={42} x2={210} y2={48} stroke="#333" strokeWidth="0.8" />
      <line x1={130} y1={112} x2={98} y2={128} stroke="#333" strokeWidth="0.8" />
      <line x1={230} y1={112} x2={262} y2={128} stroke="#333" strokeWidth="0.8" />

      {/* body depan bar */}
      <rect x={98} y={126} width={164} height={12} fill="none" stroke="#333" />
      {T(180, 135, 'BODY DEPAN', 8)}

      {/* windshield */}
      <polygon points="112,142 248,142 216,190 144,190" fill="none" stroke="#333" />
      {T(180, 170, 'KACA', 9)}
      <line x1={144} y1={190} x2={100} y2={202} stroke="#333" strokeWidth="0.8" />
      <line x1={216} y1={190} x2={260} y2={202} stroke="#333" strokeWidth="0.8" />

      {/* cabin: pintu panels, kaca panes, atap, beltline */}
      <rect x={80} y={196} width={40} height={104} fill="none" stroke="#333" />
      {T(100, 250, 'PINTU', 8)}
      <rect x={240} y={196} width={40} height={104} fill="none" stroke="#333" />
      {T(260, 250, 'PINTU', 8)}
      <rect x={80} y={304} width={40} height={104} fill="none" stroke="#333" />
      {T(100, 358, 'PINTU', 8)}
      <rect x={240} y={304} width={40} height={104} fill="none" stroke="#333" />
      {T(260, 358, 'PINTU', 8)}
      {([[196, 244], [252, 300], [304, 352], [360, 408]] as Array<[number, number]>).map(([y0, y1], i) => (
        <g key={i}>
          <rect x={124} y={y0} width={34} height={y1 - y0 - 4} fill="none" stroke="#333" />
          {T(141, (y0 + y1) / 2, 'KACA', 7)}
          <rect x={202} y={y0} width={34} height={y1 - y0 - 4} fill="none" stroke="#333" />
          {T(219, (y0 + y1) / 2, 'KACA', 7)}
        </g>
      ))}
      <rect x={162} y={220} width={36} height={164} fill="none" stroke="#333" />
      {T(180, 305, 'ATAP', 8)}
      {/* beltline + LIST ticks */}
      <line x1={76} y1={302} x2={284} y2={302} stroke="#333" strokeWidth="0.8" />
      <line x1={64} y1={302} x2={76} y2={302} stroke="#333" strokeWidth="1.4" />
      <line x1={284} y1={302} x2={296} y2={302} stroke="#333" strokeWidth="1.4" />
      {T(56, 305, 'LIST', 7)}
      {T(305, 305, 'LIST', 7)}

      {/* rear glass + converging diagonals */}
      <line x1={100} y1={412} x2={144} y2={424} stroke="#333" strokeWidth="0.8" />
      <line x1={260} y1={412} x2={216} y2={424} stroke="#333" strokeWidth="0.8" />
      <polygon points="144,424 216,424 248,470 112,470" fill="none" stroke="#333" />
      {T(180, 452, 'KACA', 9)}

      {T(180, 517, '↑ DEPAN', 9)}
    </svg>
  );
}
