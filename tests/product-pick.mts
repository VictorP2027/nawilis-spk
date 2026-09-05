/**
 * THE LINE MUST ATTACH TO THE PRODUCT IT ASKED FOR.
 *
 * Turboly's select2 searches on the product NAME, and the pusher used to click
 * the FIRST result. A name that is a prefix of others therefore billed the
 * wrong product — past every guard, because the row did attach to a real
 * catalogue entry.
 *
 * VERIFIED read-only on LIVE 2026-09-05: searching "Periodic Maintenance"
 * returns GSM-NAW-PMG1..4 before TPI-NAWJAS-PM. These are those exact rows.
 *
 *   npx tsx tests/product-pick.mts
 */
import { resultIndexForSku } from '@spk/core/turboly';

let passed = 0, failed = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
};

// The real live list, in the order Turboly returned it.
const LIVE_PM = [
  'GSM-NAW-PMG1 Periodic Maintenance GSM Grade 1',
  'GSM-NAW-PMG2 Periodic Maintenance GSM Grade 2',
  'GSM-NAW-PMG3 Periodic Maintenance GSM Grade 3',
  'GSM-NAW-PMG4 Periodic Maintenance GSM Grade 4',
  'TPI-NAWJAS-PM Periodic Maintenance',
];

ok(resultIndexForSku(LIVE_PM, 'TPI-NAWJAS-PM') === 4, 'Periodic Maintenance memilih TPI-NAWJAS-PM, bukan Grade 1');
ok(resultIndexForSku(LIVE_PM, 'GSM-NAW-PMG3') === 2, 'dan tetap bisa memilih Grade 3 kalau memang itu yang diminta');

// A prefix must NOT match a longer code — this is the trap the fix must not fall into.
ok(resultIndexForSku(LIVE_PM, 'GSM-NAW-PMG') === -1, 'kode sebagian tidak cocok dengan kode yang lebih panjang');
ok(resultIndexForSku(['TPI-NAWJAS-PMX Sesuatu'], 'TPI-NAWJAS-PM') === -1, 'TPI-NAWJAS-PM tidak cocok dengan TPI-NAWJAS-PMX');

// Unknown SKU → -1, which makes the caller fall back to the first result,
// exactly the old behaviour.
ok(resultIndexForSku(LIVE_PM, 'TIDAK-ADA-SKU') === -1, 'SKU tak dikenal → -1 → perilaku lama (hasil pertama)');
ok(resultIndexForSku(LIVE_PM, '') === -1, 'SKU kosong → -1 → perilaku lama');

// Rows that are just the code, and whitespace/case noise.
ok(resultIndexForSku(['JAS-NAWJAS-GC'], 'jas-nawjas-gc') === 0, 'baris hanya kode, beda huruf besar-kecil');
ok(resultIndexForSku(['  BAN-HAN-16513LV01   Hankook 165 R13 LV01  '], 'BAN-HAN-16513LV01') === 0, 'spasi berlebih tidak mengganggu');

// The everyday case: one result, already correct — identical outcome to before.
ok(resultIndexForSku(['GRS-NAW-SU Spooring Ulangan'], 'GRS-NAW-SU') === 0, 'satu hasil yang sudah benar tetap dipilih');

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
