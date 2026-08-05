import { z } from 'zod';
import type { CheckGoInspectionItem, CheckGoReport } from '@spk/core';
import {
  CHECKGO_SECTIONS,
  CHECKGO_VERDICTS,
  CHECKGO_ELECTRICAL,
  CHECKGO_TIRE,
  CHECKGO_REKOMENDASI,
} from './refdata.client';

/**
 * The Check & Go paper sheet: how it arrives, what counts as filled in, and how
 * it projects onto the flat rows the rest of the system reads.
 *
 * This lives outside the route because it is the ONE definition of that
 * projection and more than one caller needs it — /api/checkgo today, and the
 * second intake at /checkgo/sheet, which still writes its own free-text rows
 * and so records the same physical check in a shape the 23 branches cannot be
 * aggregated across. Anything that turns a sheet into rows belongs here, so
 * the two intakes cannot silently drift apart again.
 */

/**
 * The paper report as the tablet sends it: refdata CODES, never labels. Codes
 * are stable; the printed wording is not, and a document that stored labels
 * would freeze this year's wording into last year's records. Every field is
 * loose (plain strings, all optional) — the form ships the whole sheet and
 * `normalizeReport` below is the ONE place that decides what counts as filled.
 */
export const CheckReportInput = z.object({
  sections: z
    .array(
      z.object({
        code: z.string(),
        verdict: z.string().nullish(),
        readings: z.array(z.object({ code: z.string(), value: z.string() })).default([]),
      }),
    )
    .default([]),
  electrical: z.string().nullish(),
  tires: z
    .array(
      z.object({
        position: z.string(),
        merk: z.string().nullish(),
        tekanan: z.string().nullish(),
        flags: z.array(z.object({ code: z.string(), choice: z.string().nullish() })).default([]),
      }),
    )
    .default([]),
  rekomendasi: z.array(z.object({ code: z.string(), picks: z.array(z.string()).default([]) })).default([]),
  lainLain: z.string().nullish(),
});


/**
 * WHAT GETS STORED, and why it is two things.
 *
 * `checkGo.report` is the sheet itself, in codes — lossless, re-renderable,
 * and the thing to read when someone asks "what did the tablet say".
 * `checkGo.inspectionItems` is a DERIVED, flat, human-readable projection of
 * that report, kept in the exact shape it has always had because it is the
 * only part anyone downstream reads: apps/worker/src/flow-once.ts joins
 * `item` + `catatan` into the line it types into Turboly. Deriving instead of
 * reshaping is what lets the paper form change without touching the worker.
 */
export const intakeRow = (item: string, hasil: string | null, catatan: string | null): CheckGoInspectionItem => ({
  item,
  hasil,
  catatan,
  // feedback/recommendation/inspected belong to the MECHANIC and are filled
  // later on the flow board. Intake never seeds them, or his verdict would
  // already be on the line before he opened the bonnet.
  feedback: null,
  recommendation: null,
  inspected: false,
});

const trimmed = (v: string | null | undefined): string => (v ?? '').trim();

/**
 * Keep only answers that exist in the refdata tables AND that someone actually
 * filled in. Walking the TABLES (not the submitted array) does three jobs at
 * once: unknown codes from a stale tablet are dropped, the stored order is the
 * order printed on the sheet, and duplicates collapse. A report nobody touched
 * normalizes to null — a Check & Go where the sheet was never run must not
 * leave a husk of empty sections on the document.
 */
export function normalizeReport(raw: z.infer<typeof CheckReportInput>): CheckGoReport | null {
  const sections = CHECKGO_SECTIONS.map((sec) => {
    const got = raw.sections.find((s) => s.code === sec.code);
    const verdict = trimmed(got?.verdict);
    const readings = sec.subItems
      .filter((si) => si.measure)
      .map((si) => ({ code: si.code, value: trimmed(got?.readings.find((r) => r.code === si.code)?.value) }))
      .filter((r) => r.value !== '');
    return {
      code: sec.code,
      verdict: CHECKGO_VERDICTS.some((v) => v.value === verdict) ? verdict : null,
      readings,
    };
  }).filter((s) => s.verdict !== null || s.readings.length > 0);

  const elecPick = trimmed(raw.electrical);
  const electrical = CHECKGO_ELECTRICAL.options.some((o) => o.code === elecPick) ? elecPick : '';

  const tires = CHECKGO_TIRE.positions
    .map((pos) => {
      const got = raw.tires.find((t) => t.position === pos.code);
      const flags = CHECKGO_TIRE.flags
        .filter((f) => got?.flags.some((x) => x.code === f.code))
        .map((f) => {
          const choice = trimmed(got?.flags.find((x) => x.code === f.code)?.choice);
          return { code: f.code, choice: f.choices?.includes(choice) ? choice : null };
        });
      return {
        position: pos.code,
        merk: trimmed(got?.merk) || null,
        tekanan: trimmed(got?.tekanan) || null,
        flags,
      };
    })
    .filter((t) => t.merk !== null || t.tekanan !== null || t.flags.length > 0);

  const rekomendasi = CHECKGO_REKOMENDASI.map((g) => {
    const picked = raw.rekomendasi.find((x) => x.code === g.code)?.picks ?? [];
    return { code: g.code, picks: g.options.filter((o) => picked.includes(o.code)).map((o) => o.code) };
  }).filter((g) => g.picks.length > 0);

  const lainLain = trimmed(raw.lainLain) || null;

  if (!sections.length && !electrical && !tires.length && !rekomendasi.length && !lainLain) return null;
  return { sections, electrical: electrical || null, tires, rekomendasi, lainLain };
}

/**
 * Project the report onto the flat rows described above. Section verdicts are
 * repeated into `catatan` on purpose: `hasil` is ours alone, and item+catatan
 * is the only text that reaches Turboly — without it the pushed line would say
 * what was measured but never whether it passed.
 */
export function rowsFromReport(rep: CheckGoReport): CheckGoInspectionItem[] {
  const rows: CheckGoInspectionItem[] = [];
  const push = (item: string, hasil: string | null, parts: Array<string | null>) => {
    const catatan = parts.filter((p): p is string => !!p).join(' · ');
    rows.push(intakeRow(item, hasil, catatan || null));
  };

  for (const sec of CHECKGO_SECTIONS) {
    const s = rep.sections.find((x) => x.code === sec.code);
    if (!s) continue;
    const readings = s.readings.map((r) => {
      const si = sec.subItems.find((x) => x.code === r.code);
      return si ? `${si.label} ${r.value} ${si.measure?.unit ?? ''}`.trim() : null;
    });
    push(`${sec.no}. ${sec.title}`, s.verdict, [s.verdict, ...readings]);
  }

  const elec = CHECKGO_ELECTRICAL.options.find((o) => o.code === rep.electrical);
  if (elec) push(`${CHECKGO_ELECTRICAL.no}. ${CHECKGO_ELECTRICAL.title}`, elec.label, [elec.label]);

  for (const pos of CHECKGO_TIRE.positions) {
    const t = rep.tires.find((x) => x.position === pos.code);
    if (!t) continue;
    const marks = t.flags.map((f) => {
      const def = CHECKGO_TIRE.flags.find((x) => x.code === f.code);
      return def ? `${def.label}${f.choice ? ` (${f.choice})` : ''}` : null;
    });
    // One row per wheel: a single "Ban" row would hide WHICH tyre is cracked.
    push(`${CHECKGO_TIRE.no}. ${CHECKGO_TIRE.title} — ${pos.label}`, null, [
      t.merk,
      t.tekanan ? `Tekanan Angin ${t.tekanan}` : null,
      ...marks,
    ]);
  }

  for (const g of CHECKGO_REKOMENDASI) {
    const labels = (rep.rekomendasi.find((x) => x.code === g.code)?.picks ?? []).map(
      (c) => g.options.find((o) => o.code === c)?.label ?? null,
    );
    // The sheet prints "Lain-lain :" under the 1 - 5 list, so it rides with it.
    const extra = g.freeTextLabel && rep.lainLain ? `${g.freeTextLabel} ${rep.lainLain}` : null;
    if (!labels.length && !extra) continue;
    // These are the CHECKER's recommendations, so they stay in the note. The
    // `recommendation` field is the mechanic's answer and must stay empty here.
    push(g.title, null, [...labels, extra]);
  }

  return rows;
}
