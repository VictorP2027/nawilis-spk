/* eslint-disable @next/next/no-img-element */
/**
 * The official NAWILIS lockup, pixel-exact. /nawilis-white.png is the brand's
 * own white-logo.svg (nawilis.com) rasterized once at 120 px — emblem, italic
 * wordmark, and SPOORING - BALANCING SPECIALIST tagline, the on-dark variant
 * the brand itself uses on its blue footer. The page name rides after it in
 * brand yellow. (The color variant for light/paper backgrounds is
 * /nawilis-logo.webp — used by the print pages.)
 */
export default function BrandMark({ page }: { page: string }) {
  return (
    <span className="brandmark">
      <img src="/nawilis-white.png" alt="NAWILIS" style={{ height: 30, width: 'auto', display: 'block' }} />
      <span className="bm-page">· {page}</span>
    </span>
  );
}
