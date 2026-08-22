/**
 * Matching a typed person name against Turboly's own list.
 *
 * Intake writes whatever the customer's copy of the SPK says — usually a first
 * name ("WIDYA") — while Turboly's user list carries the full registered name
 * ("WIDYA SARI"). Demanding an exact string killed a live push with the
 * matching person sitting right there in the reported list of options, so the
 * name is matched by WORDS, widening one step at a time.
 *
 * The one rule that never bends: a wrong advisor takes someone else's sales
 * credit, so a name is only ever resolved when EXACTLY ONE option can be
 * meant. Two plausible people is an error to report, never a coin flip — and
 * ambiguity at a strong rule stops the search rather than falling through to a
 * weaker rule that happens to single one out.
 */

export type PersonMatchHow = 'exact' | 'starts-with' | 'typed-longer' | 'contains';

export type PersonMatchResult = {
  /** The option text to select, verbatim as Turboly rendered it; null when unresolved. */
  text: string | null;
  how: PersonMatchHow | null;
  /** Populated only when several options could be meant — report, never pick. */
  ambiguous: string[];
};

/** Uppercase, drop punctuation, collapse spaces: "Dyah  Setyarini," -> "DYAH SETYARINI". */
export const normPerson = (s: string): string =>
  (s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const words = (s: string): string[] => (normPerson(s) ? normPerson(s).split(' ') : []);

/** Does `hay` contain `needle` as a contiguous run of whole words? */
const hasRun = (hay: string[], needle: string[]): boolean => {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

const startsWithRun = (hay: string[], needle: string[]): boolean =>
  needle.length > 0 && needle.length <= hay.length && needle.every((w, i) => hay[i] === w);

export function matchPersonLabel(options: readonly string[], label: string): PersonMatchResult {
  const want = words(label);
  const none: PersonMatchResult = { text: null, how: null, ambiguous: [] };
  if (!want.length) return none;

  const cands = options.filter((o) => words(o).length);

  const exact = cands.filter((o) => normPerson(o) === normPerson(label));
  if (exact.length === 1) return { text: exact[0]!, how: 'exact', ambiguous: [] };
  // Two identically-named users in one store: Turboly's own list can't tell
  // them apart either, so neither can we.
  if (exact.length > 1) return { text: null, how: null, ambiguous: exact };

  // A single initial or a two-letter fragment is not enough to identify a
  // person; only an exact hit counts below that length.
  if (normPerson(label).replace(/ /g, '').length < 3) return none;

  const rules: Array<[PersonMatchHow, (opt: string[]) => boolean]> = [
    // "WIDYA" -> "WIDYA SARI" (the live case: intake keeps the first name).
    ['starts-with', (opt) => startsWithRun(opt, want)],
    // "WIDYA SARI PUTRI" -> "WIDYA SARI" (intake carries more than Turboly holds).
    ['typed-longer', (opt) => startsWithRun(want, opt)],
    // "SARI" -> "WIDYA SARI" (a middle or last name typed on its own).
    ['contains', (opt) => hasRun(opt, want)],
  ];

  for (const [how, test] of rules) {
    const hits = cands.filter((o) => test(words(o)));
    if (hits.length === 1) return { text: hits[0]!, how, ambiguous: [] };
    // Several people fit this reading — stop here and report them. Falling
    // through to a looser rule that singles one out would be guessing.
    if (hits.length > 1) return { text: null, how: null, ambiguous: hits };
  }
  return none;
}

/**
 * Same rule applied to a mirror map (normalized name -> person). Kept here so
 * validation, the push runner and the merge repair all decide identically —
 * a name that validates must also be selectable, or the SPK passes review and
 * then dies at the Turboly dropdown.
 */
export function lookupPerson<T extends { name: string }>(
  byName: ReadonlyMap<string, T>,
  label: string,
): T | null {
  if (!label?.trim() || byName.size === 0) return null;
  const people = [...byName.values()];
  const m = matchPersonLabel(people.map((p) => p.name), label);
  if (!m.text) return null;
  return people.find((p) => p.name === m.text) ?? null;
}
