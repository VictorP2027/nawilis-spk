/**
 * Check & Go sheet → inspection rows.
 *
 * The rebuilt paper form posts EVERY slot on the sheet — all four sections,
 * all four wheels, every measure — whether or not anyone wrote in them. The
 * question this file answers is the one the rebuild raised: how many rows does
 * one sheet actually produce? Each row becomes an "Add Category" block typed
 * into the Turboly Service Order by the flow board's Isi Inspeksi action, so
 * the count is not cosmetic.
 */
import assert from 'node:assert/strict';
import {
  CheckReportInput,
  normalizeReport,
  rowsFromReport,
} from '../apps/web/lib/checkgoReport.js';
import {
  CHECKGO_SECTIONS,
  CHECKGO_VERDICTS,
  CHECKGO_ELECTRICAL,
  CHECKGO_TIRE,
  CHECKGO_REKOMENDASI,
} from '../apps/web/lib/refdata.client.js';

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

/** Exactly what apps/web/app/checkgo/page.tsx builds, at three fill levels. */
function payload(fill: 'blank' | 'partial' | 'full'): unknown {
  const full = fill === 'full';
  return {
    sections: CHECKGO_SECTIONS.map((s, i) => ({
      code: s.code,
      verdict: full || (fill === 'partial' && i === 0) ? CHECKGO_VERDICTS[0]!.value : '',
      readings: s.subItems
        .filter((si) => si.measure)
        .map((si) => ({ code: si.code, value: full ? '5' : '' })),
    })),
    electrical: full ? CHECKGO_ELECTRICAL.options[0]!.code : '',
    tires: CHECKGO_TIRE.positions.map((p) => ({
      position: p.code,
      merk: full ? 'Bridgestone' : '',
      tekanan: full ? '32' : '',
      flags: full ? [{ code: CHECKGO_TIRE.flags[0]!.code, choice: null }] : [],
    })),
    rekomendasi: CHECKGO_REKOMENDASI.map((g) => ({
      code: g.code,
      picks: full ? [g.options[0]!.code] : [],
    })),
    lainLain: '',
  };
}

const rowsFor = (fill: 'blank' | 'partial' | 'full') => {
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

t('one filled section yields exactly one row — not one per posted slot', () => {
  const rows = rowsFor('partial');
  assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}: ${rows.map((r) => r.item).join(' | ')}`);
  assert.ok(rows[0]!.item.startsWith(`${CHECKGO_SECTIONS[0]!.no}.`));
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
  const ceiling =
    CHECKGO_SECTIONS.length + 1 + CHECKGO_TIRE.positions.length + CHECKGO_REKOMENDASI.length;
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
  for (const r of rowsFor('partial')) {
    assert.ok(!/\s{2,}/.test(r.catatan ?? ''), `"${r.catatan}" has the gap an empty reading leaves`);
  }
});

t('unknown codes from a stale tablet are dropped, not stored', () => {
  const parsed = CheckReportInput.safeParse({
    ...(payload('partial') as Record<string, unknown>),
    electrical: 'NOT_A_REAL_CODE',
  });
  assert.ok(parsed.success);
  const report = normalizeReport(parsed.data);
  assert.equal(report?.electrical ?? null, null);
});

console.log(`\ncheckgo-rows: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
