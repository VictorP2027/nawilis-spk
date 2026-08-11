/**
 * Indonesian-domain parsing & normalisation. These are the silent-corruption
 * traps the validation layer exists to catch. Every function here is pure and
 * deterministic so it can run identically on the device (Layer 1) and the
 * server (Layer 2).
 */

// ─────────────────────────────────────────────────────────────────────────
// License plate (No. Polisi)
// ─────────────────────────────────────────────────────────────────────────

/** Area-code letter prefixes (front code). Not exhaustive; extend from data. */
export const PLATE_AREA_CODES = new Set([
  'A', 'AA', 'AB', 'AD', 'AE', 'AG', 'B', 'BA', 'BB', 'BD', 'BE', 'BG', 'BH', 'BK', 'BL', 'BM',
  'BN', 'BP', 'D', 'DA', 'DB', 'DC', 'DD', 'DE', 'DG', 'DH', 'DK', 'DL', 'DM', 'DN', 'DP', 'DR',
  'DS', 'DT', 'E', 'EA', 'EB', 'ED', 'F', 'G', 'H', 'K', 'KB', 'KH', 'KT', 'KU', 'L', 'M', 'N',
  'P', 'PA', 'PB', 'R', 'S', 'T', 'W', 'Z',
]);

const PLATE_RE = /^([A-Z]{1,2})\s?(\d{1,4})\s?([A-Z]{0,3})$/;

/** Position-aware OCR confusion maps: what a mis-read glyph should become. */
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', S: '5', B: '8', I: '1', L: '1', Z: '2', G: '6', T: '7' };
const TO_LETTER: Record<string, string> = { '0': 'O', '5': 'S', '8': 'B', '1': 'I', '2': 'Z', '6': 'G' };

export interface PlateParse {
  ok: boolean;
  full: string; // canonical, no spaces, e.g. B1234SZA
  display: string; // e.g. "B 1234 SZA"
  area: string;
  number: string;
  suffix: string;
  areaKnown: boolean;
  correctionsApplied: string[];
}

/** Force a block to digits (OCR confusion aware). Returns null if impossible. */
function toDigits(s: string, corr: string[], tag: string): string | null {
  let out = '';
  for (const c of s) {
    if (/[0-9]/.test(c)) out += c;
    else if (TO_DIGIT[c]) {
      corr.push(`${tag}:${c}->${TO_DIGIT[c]}`);
      out += TO_DIGIT[c];
    } else return null;
  }
  return out;
}

/** Force a block to letters (OCR confusion aware). Returns null if impossible. */
function toLetters(s: string, corr: string[], tag: string): string | null {
  let out = '';
  for (const c of s) {
    if (/[A-Z]/.test(c)) out += c;
    else if (TO_LETTER[c]) {
      corr.push(`${tag}:${c}->${TO_LETTER[c]}`);
      out += TO_LETTER[c];
    } else return null;
  }
  return out;
}

interface Candidate {
  area: string;
  number: string;
  suffix: string;
  corrections: string[];
  score: number;
}

/**
 * Parse + position-aware correct a plate. Corrections are RECORDED, never hidden:
 * a non-empty `correctionsApplied` caps the review tier at CONFIRM.
 *
 * We evaluate every candidate split (area length 1 or 2 × number length 1–4)
 * and pick the best-scoring one. What is typed wins: a split that reads
 * cleanly always outranks one that rewrites a character, so "BO123SZA" is
 * BO 123 SZA — not B 0123 SZA with an invented 0. Correcting a glyph is the
 * last resort, for input no split reads cleanly.
 */
export function parsePlate(raw: string): PlateParse {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const candidates: Candidate[] = [];

  for (const areaLen of [1, 2]) {
    if (cleaned.length < areaLen + 1) continue;
    const rawArea = cleaned.slice(0, areaLen);
    const rest = cleaned.slice(areaLen);
    /**
     * EVERY number length is a candidate — the score decides, not the order.
     *
     * This used to stop at the first (longest) block it could force into
     * digits, which meant a letter next to the number was eaten whenever the
     * OCR table had a digit for it. "QQ 999 QWQ" came back as "Q 0999 QWQ"
     * (Q->0) and "AA 188 BBB" as "AA 1888 BB" (B->8): a correction-free split
     * existed in both cases, scored higher, and was never generated to be
     * compared. Enumerating them costs at most four extra candidates per area
     * length, and the existing scoring already prefers fewer corrections.
     */
    for (let k = Math.min(4, rest.length); k >= 1; k--) {
      const rawNum = rest.slice(0, k);
      const rawSuf = rest.slice(k);
      if (rawSuf.length > 3) continue;
      const corr: string[] = [];
      const area = toLetters(rawArea, corr, 'area');
      if (area === null) continue;
      const number = toDigits(rawNum, corr, 'num');
      if (number === null) continue;
      const suffix = rawSuf.length ? toLetters(rawSuf, corr, 'suf') : '';
      if (suffix === null) continue;
      const known = PLATE_AREA_CODES.has(area);
      /**
       * A reading that changes nothing ALWAYS beats one that changes a
       * character. The -100 is not a weight to be traded against; it puts
       * every corrected split below every clean one, whatever else they score.
       *
       * These plates are TYPED, not photographed. "BO123SZA" is someone typing
       * BO 123 SZA, so that is what it must be — the old scoring bought the
       * known area code "B" for the price of an O->0 and returned B 0123 SZA,
       * inventing a digit nobody entered. Correction stays for the case it is
       * genuinely needed: when NO split of the input reads cleanly.
       *
       * Below that line: prefer a known area (+3), then a longer number block
       * (+0.1 each, tie-break only).
       */
      const score = -100 * corr.length + (known ? 3 : 0) + k * 0.1;
      candidates.push({ area, number, suffix, corrections: corr, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    return { ok: false, full: cleaned, display: cleaned, area: '', number: '', suffix: '', areaKnown: false, correctionsApplied: [] };
  }
  const full = `${best.area}${best.number}${best.suffix}`;
  const display = [best.area, best.number, best.suffix].filter(Boolean).join(' ');
  return {
    ok: PLATE_RE.test(display),
    full,
    display,
    area: best.area,
    number: best.number,
    suffix: best.suffix,
    areaKnown: PLATE_AREA_CODES.has(best.area),
    correctionsApplied: best.corrections,
  };
}

/** OCR-confusion neighbourhood for multikey lookup on returning vehicles. */
export function plateVariants(full: string): string[] {
  const variants = new Set<string>([full]);
  // Flip each digit/letter to its confusable partner, one at a time.
  const both: Record<string, string[]> = {
    '0': ['O'], O: ['0'], '1': ['I', 'L'], I: ['1'], L: ['1'],
    '5': ['S'], S: ['5'], '8': ['B'], B: ['8'], '2': ['Z'], Z: ['2'], '6': ['G'], G: ['6'],
  };
  for (let i = 0; i < full.length; i++) {
    const c = full[i]!;
    for (const alt of both[c] ?? []) {
      variants.add(full.slice(0, i) + alt + full.slice(i + 1));
    }
  }
  return [...variants];
}

// ─────────────────────────────────────────────────────────────────────────
// Odometer (KM) — id-ID uses '.' for thousands, ',' for decimal
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse an odometer string written in Indonesian convention.
 * "45.230" -> 45230 (NOT 45.23). Assuming English convention is a silent 1000×
 * error that then poisons monotonicity for every future visit.
 */
export function parseKm(raw: string): { value: number | null; raw: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, raw };
  // Strip everything except digits, dot, comma.
  const s = trimmed.replace(/[^\d.,]/g, '');
  // Odometers are integers. Treat '.' and ',' both as thousands separators and drop them;
  // a decimal odometer reading does not exist in practice.
  const digits = s.replace(/[.,]/g, '');
  if (digits === '') return { value: null, raw };
  const value = Number.parseInt(digits, 10);
  return { value: Number.isFinite(value) ? value : null, raw };
}

// ─────────────────────────────────────────────────────────────────────────
// Mobile number (Nomor WA) — normalise to E.164 (+62)
// ─────────────────────────────────────────────────────────────────────────

/** 3-digit operator prefixes (after the leading 8) for a sanity check. */
const OPERATOR_PREFIXES = new Set([
  // Telkomsel
  '811', '812', '813', '814', '821', '822', '823', '851', '852', '853',
  // Indosat
  '814', '815', '816', '855', '856', '857', '858',
  // XL
  '817', '818', '819', '859', '877', '878',
  // Axis
  '831', '832', '833', '838',
  // Three
  '895', '896', '897', '898', '899',
  // Smartfren
  '881', '882', '883', '884', '885', '886', '887', '888', '889',
]);

export interface WaParse {
  e164: string | null;
  ok: boolean;
  operatorKnown: boolean;
}

export function parseWa(raw: string): WaParse {
  const digits = raw.replace(/[^\d]/g, '');

  // A number written with an explicit leading "+" that is NOT Indonesian is
  // taken at face value. Nawilis is an Indonesian chain and effectively every
  // customer is local, so the rules below stay exactly as they were for
  // everything typed the normal way ("0812…", "812…", "62812…"). But a foreign
  // number is a real thing a branch can be handed — an expat, a corporate
  // fleet contact abroad — and it used to be refused outright at intake with
  // "nomor WhatsApp customer tidak valid", which is wrong and unfixable by
  // whoever typed it.
  //
  // The "+" is required, and is doing real work: it is the customer asserting
  // a country code. Without it, a typo like "12345678" would sail through as
  // a valid international number instead of being caught, so bare digits keep
  // going down the Indonesian path and keep failing loudly when malformed.
  if (raw.trim().startsWith('+') && !digits.startsWith('62')) {
    const local = digits.startsWith('0') ? '' : digits;
    // E.164: 15 digits max including the country code. The floor is deliberately
    // loose (a few countries have very short national numbers) — this validates
    // shape, not reachability, and the gateway is the real arbiter of that.
    if (local.length >= 8 && local.length <= 15) {
      return { e164: `+${local}`, ok: true, operatorKnown: false };
    }
    return { e164: null, ok: false, operatorKnown: false };
  }

  let national: string;
  if (digits.startsWith('62')) national = digits.slice(2);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;
  // Indonesian mobiles start with 8, total national length 9–12.
  if (!national.startsWith('8') || national.length < 9 || national.length > 12) {
    return { e164: null, ok: false, operatorKnown: false };
  }
  // Operator code is the first 3 digits of the national number, e.g. "812".
  const prefix = national.slice(0, 3);
  return {
    e164: `+62${national}`,
    ok: true,
    operatorKnown: OPERATOR_PREFIXES.has(prefix),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Brand normalisation (Jaro-Winkler ≥ 0.92 only)
// ─────────────────────────────────────────────────────────────────────────

export function jaroWinkler(a: string, b: string): number {
  const s1 = a.toUpperCase();
  const s2 = b.toUpperCase();
  if (s1 === s2) return 1;
  const m = Math.max(s1.length, s2.length);
  if (m === 0) return 1;
  const matchDist = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
  // Winkler prefix bonus (max 4 chars).
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface BrandMatch {
  normalized: string | null;
  score: number;
  raw: string;
}

/** Match a raw brand against a controlled vocabulary. Threshold 0.92 by design. */
export function normalizeBrand(raw: string, vocab: readonly string[]): BrandMatch {
  const up = raw.trim().toUpperCase();
  if (up === '') return { normalized: null, score: 0, raw };
  let best: string | null = null;
  let bestScore = 0;
  for (const v of vocab) {
    const s = jaroWinkler(up, v);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return { normalized: bestScore >= 0.92 ? best : null, score: bestScore, raw };
}

/**
 * Canonical phone identity key: digits only, country code (62) stripped, leading
 * 0 stripped. "0223456789", "223456789", "+62223456789", "62223456789" → "223456789".
 */
export function canonPhoneKey(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (d.startsWith('62')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Display/storage form: canonical key with the leading 0 (Indonesian local). */
export function localPhone(raw: string): string {
  const k = canonPhoneKey(raw);
  return k ? '0' + k : '';
}

/** Asia/Jakarta calendar day (YYYY-MM-DD) for a given instant. */
export function jakartaBusinessDate(iso: string): string {
  const d = new Date(iso);
  // WIB is UTC+7, no DST.
  const wib = new Date(d.getTime() + 7 * 3600 * 1000);
  return wib.toISOString().slice(0, 10);
}
