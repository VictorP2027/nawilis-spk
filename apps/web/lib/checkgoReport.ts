import { z } from 'zod';
import type { CheckGoInspectionItem, CheckGoReport } from '@spk/core';
import { CHECKGO_SECTIONS, CHECKGO_TIRE } from './refdata.client';

/**
 * The Check & Go paper sheet (final 3): how it arrives, what counts as filled
 * in, and how it projects onto the flat rows the rest of the system reads.
 *
 * This lives outside the route because it is the ONE definition of that
 * projection and more than one caller needs it. Anything that turns a sheet
 * into rows belongs here, so intakes cannot silently drift apart.
 *
 * The final-3 sheet has eight sections with per-row verdict pairs and
 * per-section recommendation checklists. Everything is validated against the
 * refdata TABLES (not the submitted arrays): unknown codes from a stale tablet
 * are dropped, the stored order is the printed order, duplicates collapse, and
 * a report nobody touched normalizes to null.
 */

export const CheckReportInput = z.object({
  sections: z
    .array(
      z.object({
        code: z.string(),
        verdict: z.string().nullish(),
        items: z
          .array(
            z.object({
              code: z.string(),
              verdict: z.string().nullish(),
              readings: z.array(z.object({ code: z.string(), value: z.string() })).default([]),
            }),
          )
          .default([]),
        rekomendasi: z.array(z.string()).default([]),
        rekomendasiLain: z.string().nullish(),
        extraParts: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  tires: z
    .array(
      z.object({
        position: z.string(),
        merkUkuran: z.string().nullish(),
        tekanan: z.string().nullish(),
        flags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  tireRekomendasi: z
    .object({ picks: z.array(z.string()).default([]), lain: z.array(z.string()).default([]) })
    .default({ picks: [], lain: [] }),
});

/**
 * WHAT GETS STORED, and why it is two things.
 *
 * `checkGo.report` is the sheet itself, in codes — lossless, re-renderable,
 * and the thing to read when someone asks "what did the tablet say".
 * `checkGo.inspectionItems` is a DERIVED, flat, human-readable projection of
 * that report, kept in the exact shape it has always had because it is the
 * only part anyone downstream reads: apps/worker/src/flow-once.ts joins
 * `item` + `catatan` into the line it types into Turboly, and the WhatsApp
 * alert reads `hasil` for its "Perlu perhatian" list. Deriving instead of
 * reshaping is what lets the paper form change without touching the worker —
 * this file is the second sheet revision the same contract has absorbed.
 */
export const intakeRow = (item: string, hasil: string | null, catatan: string | null): CheckGoInspectionItem => ({
  item,
  hasil,
  catatan,
  // feedback/recommendation/inspected belong to the MECHANIC and are filled
  // later on the flow board. Intake never seeds them.
  feedback: null,
  recommendation: null,
  inspected: false,
});

const trimmed = (v: string | null | undefined): string => (v ?? '').trim();

/** The parts of a note are joined with this — the alert splits on it again. */
const NOTE_SEP = ' · ';

export function normalizeReport(raw: z.infer<typeof CheckReportInput>): CheckGoReport | null {
  const sections = CHECKGO_SECTIONS.map((sec) => {
    const got = raw.sections.find((s) => s.code === sec.code);

    const secVerdictRaw = trimmed(got?.verdict);
    const verdict = sec.verdicts?.some((v) => v.code === secVerdictRaw) ? secVerdictRaw : null;

    const items = sec.items
      .map((it) => {
        const gi = got?.items.find((x) => x.code === it.code);
        const vRaw = trimmed(gi?.verdict);
        const v = it.verdicts?.some((o) => o.code === vRaw) ? vRaw : null;
        const readings = (it.readings ?? [])
          .map((r) => ({ code: r.code, value: trimmed(gi?.readings.find((x) => x.code === r.code)?.value) }))
          .filter((r) => r.value !== '');
        return { code: it.code, verdict: v, readings };
      })
      .filter((it) => it.verdict !== null || it.readings.length > 0);

    const rekomendasi = sec.rekomendasi.filter((o) => got?.rekomendasi.includes(o.code)).map((o) => o.code);
    const rekomendasiLain = sec.rekomendasi.some((o) => o.freeText && rekomendasi.includes(o.code))
      ? trimmed(got?.rekomendasiLain) || null
      : null;
    const extraParts = sec.extraList
      ? (got?.extraParts ?? []).map((p) => p.trim()).filter((p) => p !== '').slice(0, sec.extraList.count)
      : [];

    return { code: sec.code, verdict, items, rekomendasi, rekomendasiLain, extraParts };
  }).filter((s) => s.verdict !== null || s.items.length > 0 || s.rekomendasi.length > 0 || s.extraParts.length > 0);

  const tires = CHECKGO_TIRE.positions
    .map((pos) => {
      const got = raw.tires.find((t) => t.position === pos.code);
      const tekananRaw = trimmed(got?.tekanan);
      return {
        position: pos.code,
        merkUkuran: trimmed(got?.merkUkuran) || null,
        tekanan: CHECKGO_TIRE.tekanan.some((o) => o.code === tekananRaw) ? tekananRaw : null,
        flags: CHECKGO_TIRE.flags.filter((f) => got?.flags.includes(f.code)).map((f) => f.code),
      };
    })
    .filter((t) => t.merkUkuran !== null || t.tekanan !== null || t.flags.length > 0);

  const tireRekomendasi = {
    picks: CHECKGO_TIRE.rekomendasi.filter((o) => raw.tireRekomendasi.picks.includes(o.code)).map((o) => o.code),
    lain: raw.tireRekomendasi.lain.map((l) => l.trim()).filter((l) => l !== '').slice(0, CHECKGO_TIRE.freeLines),
  };

  if (!sections.length && !tires.length && !tireRekomendasi.picks.length && !tireRekomendasi.lain.length) return null;
  return { sections, tires, tireRekomendasi };
}

/**
 * Project the report onto the flat rows described above.
 *
 * `hasil` carries the verdict LABEL (Kotor, Tipis, Bocor …) — a derived
 * rendering of the stored code, so re-printing survives wording changes.
 * `catatan` carries the readings. Recommendation picks become rows titled
 * "Rekomendasi …", the exact prefix the WhatsApp alert keys its
 * "Rekomendasi kami" list on.
 */
export function rowsFromReport(rep: CheckGoReport): CheckGoInspectionItem[] {
  const rows: CheckGoInspectionItem[] = [];
  const push = (item: string, hasil: string | null, parts: Array<string | null>) => {
    const catatan = parts.filter((p): p is string => !!p && p.trim() !== '').join(NOTE_SEP);
    rows.push(intakeRow(item, hasil, catatan || null));
  };

  for (const sec of CHECKGO_SECTIONS) {
    const s = rep.sections.find((x) => x.code === sec.code);
    if (!s) continue;

    const readingText = (itCode: string): string[] => {
      const gi = s.items.find((x) => x.code === itCode);
      const def = sec.items.find((x) => x.code === itCode);
      return (gi?.readings ?? []).map((r) => {
        const rd = def?.readings?.find((x) => x.code === r.code);
        return rd ? `${rd.label} ${r.value}${rd.suffix ? ` ${rd.suffix}` : ''}` : r.value;
      });
    };

    if (sec.verdicts) {
      // Section-spanning verdict (Oli Mesin, ATF): ONE row for the section,
      // its items' readings riding along as the note.
      const label = sec.verdicts.find((v) => v.code === s.verdict)?.label ?? null;
      const notes = sec.items.flatMap((it) => {
        const txt = readingText(it.code);
        return txt.length ? [`${it.label}: ${txt.join(', ')}`] : [];
      });
      if (label || notes.length) push(`${sec.no}. ${sec.title}`, label, [label, ...notes]);
    } else {
      // Per-item verdicts: one row per item that says anything.
      for (const it of sec.items) {
        const gi = s.items.find((x) => x.code === it.code);
        if (!gi) continue;
        const label = it.verdicts?.find((v) => v.code === gi.verdict)?.label ?? null;
        const notes = readingText(it.code);
        if (label || notes.length) push(`${sec.no}. ${sec.title} — ${it.label}`, label, [label, ...notes]);
      }
    }

    if (s.rekomendasi.length || s.rekomendasiLain) {
      const labels = s.rekomendasi.map((c) => {
        const o = sec.rekomendasi.find((x) => x.code === c);
        if (!o) return c;
        return o.freeText && s.rekomendasiLain ? `${o.label} ${s.rekomendasiLain}` : o.label;
      });
      push(`Rekomendasi ${sec.title}`, null, labels);
    }
    if (s.extraParts.length && sec.extraList) {
      push(`Rekomendasi ${sec.extraList.label.toLowerCase()}`, null, s.extraParts);
    }
  }

  for (const pos of CHECKGO_TIRE.positions) {
    const t = rep.tires.find((x) => x.position === pos.code);
    if (!t) continue;
    const tekananLabel = CHECKGO_TIRE.tekanan.find((o) => o.code === t.tekanan)?.label ?? null;
    const marks = t.flags.map((f) => CHECKGO_TIRE.flags.find((x) => x.code === f)?.label ?? f);
    // One row per wheel: a single "Ban" row would hide WHICH tyre is cracked.
    push(`${CHECKGO_TIRE.no}. ${CHECKGO_TIRE.title} — ${pos.label}`, null, [
      t.merkUkuran,
      tekananLabel ? `Tekanan Ban ${tekananLabel}` : null,
      ...marks,
    ]);
  }

  if (rep.tireRekomendasi.picks.length || rep.tireRekomendasi.lain.length) {
    const labels = rep.tireRekomendasi.picks.map((c) => CHECKGO_TIRE.rekomendasi.find((o) => o.code === c)?.label ?? c);
    push(`Rekomendasi ${CHECKGO_TIRE.title}`, null, [...labels, ...rep.tireRekomendasi.lain]);
  }

  return rows;
}
