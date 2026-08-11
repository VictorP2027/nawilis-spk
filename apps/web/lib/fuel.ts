/**
 * How a fuel level is SAID. Plain module, no 'use client', because both sides
 * need it: the gauge on the tablet, and the print renderers — including the
 * admin backup, which runs on the server.
 *
 * It used to live in FuelGauge.tsx. That file is a client component, and
 * importing fuelWord from it compiled fine and then threw at request time
 * ("Attempted to call fuelWord() from the server"), taking the whole backup
 * download out with a 500 and an empty body. The vocabulary is data, not UI,
 * so it belongs somewhere neither side owns.
 */

/** The marks a gauge face actually carries. */
export const FRACTIONS: Record<number, string> = { 0: 'E', 25: '¼', 50: '½', 75: '¾', 100: 'F' };

/**
 * A needle does not stop only on the quarters, so neither does this. The value
 * snaps to the nearest EIGHTH — as fine as a gauge is ever read, and as fine as
 * a thumb can aim on a phone. Every old 0/25/50/75/100 value is an eighth, so
 * every SPK already captured still means exactly what it meant.
 */
export const STEPS = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100] as const;

export const STEP_WORDS: Record<number, string> = {
  0: 'Kosong (E)', 12.5: '⅛ tangki', 25: '¼ tangki', 37.5: '⅜ tangki', 50: '½ tangki',
  62.5: '⅝ tangki', 75: '¾ tangki', 87.5: '⅞ tangki', 100: 'Penuh (F)',
};

export function fuelWord(pct: number): string {
  return STEP_WORDS[pct] ?? `${Math.round(pct)}/100 tangki`;
}
