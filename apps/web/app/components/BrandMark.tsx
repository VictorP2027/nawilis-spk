/**
 * The official NAWILIS mark, rebuilt as a ~1 KB inline SVG — the real
 * white-logo.svg on nawilis.com is 600 KB of embedded raster, unusable in a
 * topbar. Same design language: the angled blue/yellow "W" emblem, the heavy
 * italic wordmark, the SPOORING - BALANCING SPECIALIST tagline. This is the
 * on-blue (white) variant, matching how the brand renders its logo on the
 * dark footer of the official site.
 */
export default function BrandMark({ page }: { page: string }) {
  return (
    <span className="brandmark">
      <svg width="30" height="26" viewBox="0 0 34 28" aria-hidden="true">
        {/* the emblem: two italic strokes with the yellow accents */}
        <polygon points="0,1 13,1 6.5,13" fill="#FFD400" />
        <polygon points="7,27 16,1 23,1 14,27" fill="#fff" />
        <polygon points="16,27 25,1 32,1 23,27" fill="#FFD400" />
        <polygon points="0,27 4.5,15 10.5,15 6,27" fill="#fff" />
      </svg>
      <span className="bm-text">
        <span className="bm-word">
          NAWILIS<span className="bm-page"> · {page}</span>
        </span>
        <span className="bm-tag">SPOORING - BALANCING SPECIALIST</span>
      </span>
    </span>
  );
}
