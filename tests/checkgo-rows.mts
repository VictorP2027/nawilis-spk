/**
 * Check & Go sheet (final 3) → inspection rows.
 *
 * The rebuilt paper form posts EVERY slot on the sheet — all eight sections,
 * every item's verdict pair, all four wheels — whether or not anyone wrote in
 * them. The question this file answers is the one the rebuild raised: how many
 * rows does one sheet actually produce? Each row becomes an "Add Category"
 * block typed into the Turboly Service Order by the flow board's Isi Inspeksi
 * action, so the count is not cosmetic.
 *
 * Run: npx tsx tests/checkgo-rows.mts
 */
import assert from 'node:assert/strict';
import {
  CheckReportInput,
  normalizeReport,
  rowsFromReport,
} from '../apps/web/lib/checkgoReport.js';
import { CHECKGO_SECTIONS, CHECKGO_TIRE } from '../apps/web/lib/refdata.client.js';

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
  }
}

type Fill = 'blank' | 'partial' | 'full';

/** The one thing the partial sheet says: the first verdicted item of the first per-item section. */
const PARTIAL_SEC = CHECKGO_SECTIONS.find((s) => !s.verdicts)!;
const PARTIAL_ITEM = PARTIAL_SEC.items.find((it) => it.verdicts)!;

/** Exactly what apps/web/app/checkgo/page.tsx builds, at three fill levels — codes, never labels. */
function payload(fill: Fill): unknown {
  const full = fill === 'full';
  return {
    sections: CHECKGO_SECTIONS.map((s) => ({
      code: s.code,
      verdict: full && s.verdicts ? s.verdicts[0]!.code : '',
      items: s.items.map((it) => ({
        code: it.code,
        verdict:
          (full && it.verdicts) ||
          (fill === 'partial' && s.code === PARTIAL_SEC.code && it.code === PARTIAL_ITEM.code)
            ? it.verdicts?.[0]!.code ?? ''
            : '',
        readings: (it.readings ?? []).map((r) => ({ code: r.code, value: full ? '5' : '' })),
      })),
      rekomendasi: full ? s.rekomendasi.map((o) => o.code) : [],
      rekomendasiLain: full && s.rekomendasi.some((o) => o.freeText) ? 'H4 LED' : '',
      extraParts: full && s.extraList
        ? Array.from({ length: s.extraList.count }, (_, i) => `Part suspensi ${i + 1}`)
        : [],
    })),
    tires: CHECKGO_TIRE.positions.map((p) => ({
      position: p.code,
      merkUkuran: full ? 'Bridgestone 185/65R15' : '',
      tekanan: full ? CHECKGO_TIRE.tekanan[0]!.code : '',
      flags: full ? CHECKGO_TIRE.flags.map((f) => f.code) : [],
    })),
    tireRekomendasi: {
      picks: full ? CHECKGO_TIRE.rekomendasi.map((o) => o.code) : [],
      lain: full ? Array.from({ length: CHECKGO_TIRE.freeLines }, (_, i) => `Cek ban ${i + 1}`) : [],
    },
  };
}

const rowsFor = (fill: Fill) => {
  const parsed = CheckReportInput.safeParse(payload(fill));
  assert.ok(parsed.success, `payload(${fill}) must satisfy the wire schema`);
  const report = normalizeReport(parsed.data);
  return report ? rowsFromReport(report) : [];
};

t('a sheet nobody filled in normalizes to null — no report, no rows', () => {
  const parsed = CheckReportInput.safeParse(payload('blank'));
  assert.ok(parsed.success);
  assert.equal(
    normalizeReport(parsed.data),
    null,
    'a blank sheet must not leave a husk of empty sections on the document',
  );
  assert.equal(rowsFor('blank').length, 0);
});

t('one filled item yields exactly one row — not one per posted slot', () => {
  const rows = rowsFor('partial');
  assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}: ${rows.map((r) => r.item).join(' | ')}`);
  assert.ok(rows[0]!.item.startsWith(`${PARTIAL_SEC.no}. ${PARTIAL_SEC.title}`));
});

t('the verdict lands in hasil as its printed LABEL, never the stored code', () => {
  // A deliberately unhealthy pick, so label ≠ code is actually observable.
  const sec = CHECKGO_SECTIONS.find((s) => s.code === 'REM')!;
  const item = sec.items.find((it) => it.code === 'REM_KANVAS_DPN')!;
  const bad = item.verdicts![1]!; // { code: 'TIPIS', label: 'Tipis' }
  const p = payload('blank') as { sections: Array<{ code: string; items: Array<{ code: string; verdict: string }> }> };
  p.sections.find((s) => s.code === sec.code)!.items.find((i) => i.code === item.code)!.verdict = bad.code;

  const parsed = CheckReportInput.safeParse(p);
  assert.ok(parsed.success);
  const rows = rowsFromReport(normalizeReport(parsed.data)!);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hasil, bad.label, `hasil must carry "${bad.label}", got "${rows[0]!.hasil}"`);
  assert.notEqual(rows[0]!.hasil, bad.code);
});

t('no row is ever blank — every row carries a verdict or a note', () => {
  for (const fill of ['partial', 'full'] as const) {
    for (const r of rowsFor(fill)) {
      assert.ok(
        (r.hasil && r.hasil.trim() !== '') || (r.catatan && r.catatan.trim() !== ''),
        `${fill}: row "${r.item}" reaches Turboly saying nothing`,
      );
    }
  }
});

t('a fully filled sheet stays within the row budget', () => {
  const rows = rowsFor('full');
  // The ceiling the printed sheet can express, computed from the tables:
  // one row per verdicted item, one per section-spanning verdict, one
  // rekomendasi row per section that has picks, the suspension-parts row,
  // one row per wheel, and one tire-rekomendasi row.
  const perItemRows = CHECKGO_SECTIONS.filter((s) => !s.verdicts).reduce((n, s) => n + s.items.length, 0);
  const sectionVerdictRows = CHECKGO_SECTIONS.filter((s) => s.verdicts).length;
  const rekomendasiRows = CHECKGO_SECTIONS.filter((s) => s.rekomendasi.length > 0).length;
  const suspensionRows = CHECKGO_SECTIONS.filter((s) => s.extraList).length;
  const ceiling =
    perItemRows + sectionVerdictRows + rekomendasiRows + suspensionRows + CHECKGO_TIRE.positions.length + 1;
  assert.ok(rows.length <= ceiling, `${rows.length} rows exceeds the ${ceiling} the sheet can express`);
  // The number worth knowing: this is how many Add Category blocks Isi Inspeksi
  // will click through on a worst-case sheet.
  console.log(`  full sheet → ${rows.length} rows (ceiling ${ceiling})`);
});

t('intake never seeds the mechanic\'s own fields', () => {
  for (const r of rowsFor('full')) {
    assert.equal(r.feedback, null, `"${r.item}" arrives with the mechanic's verdict already on it`);
    assert.equal(r.recommendation, null, `"${r.item}" arrives with the mechanic's recommendation already on it`);
    assert.equal(r.inspected, false);
  }
});

t('readings left blank never become label-and-unit noise', () => {
  for (const fill of ['partial', 'full'] as const) {
    for (const r of rowsFor(fill)) {
      assert.ok(!/\s{2,}/.test(r.catatan ?? ''), `${fill}: "${r.catatan}" has the gap an empty reading leaves`);
    }
  }
});

t('unknown codes from a stale tablet are dropped, not stored', () => {
  const p = payload('partial') as {
    sections: Array<{ code: string; verdict: string; items: Array<{ code: string; verdict: string }>; rekomendasi: string[] }>;
    tires: Array<{ position: string; merkUkuran: string; tekanan: string; flags: string[] }>;
    tireRekomendasi: { picks: string[]; lain: string[] };
  };
  // A section the final-3 sheet no longer has…
  p.sections.push({ code: 'GHOST_SECTION', verdict: 'BAGUS', items: [{ code: 'GHOST_ITEM', verdict: 'OK' }], rekomendasi: ['GHOST_PICK'] });
  // …a verdict code that was renamed…
  p.sections.find((s) => s.code === 'OLI_MESIN')!.verdict = 'NOT_A_REAL_CODE';
  // …the previous revision's numeric tire pressure and an unknown mark…
  p.tires[0] = { position: CHECKGO_TIRE.positions[0]!.code, merkUkuran: '', tekanan: '32', flags: ['MELEDAK'] };
  // …and a recommendation pick that never existed.
  p.tireRekomendasi.picks = ['NITROGEN'];

  const parsed = CheckReportInput.safeParse(p);
  assert.ok(parsed.success, 'stale payloads still parse — the dropping happens in normalizeReport');
  const report = normalizeReport(parsed.data);
  assert.ok(report, 'the one genuine answer keeps the report alive');
  assert.ok(!report.sections.some((s) => s.code === 'GHOST_SECTION'), 'an unknown section is dropped');
  assert.ok(!report.sections.some((s) => s.code === 'OLI_MESIN'), 'an unknown verdict does not keep its section');
  assert.equal(report.tires.length, 0, 'a numeric tekanan and unknown flags leave nothing to store for the wheel');
  assert.equal(report.tireRekomendasi.picks.length, 0, 'unknown picks are dropped');
  assert.equal(rowsFromReport(report).length, 1, 'only the genuine answer becomes a row');
});

console.log(`\ncheckgo-rows: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
