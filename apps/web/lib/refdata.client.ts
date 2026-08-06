/**
 * Client-safe reference data — a small static mirror of the 12 SPK services and
 * 23 branches, so the intake PWA doesn't have to import @spk/core (which pulls
 * in mongodb/playwright). Keep in sync with packages/core/src/refdata.ts.
 */
/**
 * How each service is ORDERED on the printed SPK, read off the sheet itself:
 * a tick alone (`check`), a piece count (`pcs`), or litres (`liter`). `brandType`
 * marks the rows where the paper wants merk/tipe written next to the count —
 * Balancing on the Car and Oli ("Castrol Edge 5/30"). `tag` is the margin code
 * the branches pencil beside the row (OLM / ATF / BAN); the tablet shows it so
 * the digital row is findable by the same shorthand people already use.
 */
export const SERVICES: ReadonlyArray<{
  code: string;
  label: string;
  unit: 'check' | 'pcs' | 'liter';
  brandType?: boolean;
  tag?: string;
}> = [
  { code: 'SPOORING', label: 'Spooring', unit: 'check' },
  { code: 'BALANCING', label: 'Balancing', unit: 'pcs' },
  { code: 'BALANCING_ON_CAR', label: 'Balancing on the Car', unit: 'pcs', brandType: true },
  { code: 'OLI', label: 'Oli', unit: 'liter', brandType: true, tag: 'OLM' },
  { code: 'ENGINE_FLUSH', label: 'Engine Flush', unit: 'check' },
  { code: 'TUNE_UP_CARBON_CLEAN', label: 'Tune Up / Carbon Clean', unit: 'check' },
  { code: 'AUTM_TRANS_FLUSH', label: 'Autm Transmission Flush', unit: 'check', tag: 'ATF' },
  { code: 'KURAS_RADIATOR', label: 'Kuras Radiator', unit: 'check' },
  { code: 'SERVICE_REM', label: 'Service Rem / Krs Minyak Rem', unit: 'check' },
  { code: 'BUBUT_REM', label: 'Bubut Rem', unit: 'check' },
  { code: 'BAN', label: 'Ban', unit: 'pcs', tag: 'BAN' },
  { code: 'NITROGEN', label: 'Nitrogen', unit: 'pcs' },
];

/** 8 PENGECEKAN AWAL rows: label + the non-OK marks available on that row. */
export const CONDITION_ITEMS: ReadonlyArray<{ code: string; label: string; marks: string[] }> = [
  { code: 'PANEL_DASHBOARD', label: 'Panel Dashboard', marks: ['Panel Mati'] },
  { code: 'BODY_KENDARAAN', label: 'Body Kendaraan', marks: ['Baret', 'Penyok'] },
  { code: 'KACA_DAN_SPION', label: 'Kaca dan Spion', marks: ['Baret', 'Pecah'] },
  { code: 'VELG', label: 'Velg', marks: ['Baret', 'Penyok'] },
  { code: 'BAUT_RODA', label: 'Baut Roda', marks: ['Baret', 'Tidak Lengkap'] },
  { code: 'DOP_VELG', label: 'Dop Velg', marks: ['Baret', 'Tidak Lengkap'] },
  { code: 'TUTUP_PENTIL', label: 'Tutup Pentil', marks: ['Baret', 'Tidak Lengkap'] },
  { code: 'BAN_SEREP', label: 'Ban Serep', marks: ['Kempis', 'Tidak ada'] },
];

/**
 * Clickable zones on the car damage diagram — a top-view (front at top) that
 * mirrors the paper SPK layout. viewBox is 0 0 200 300; body spans x34..166.
 * `t` centers the label text.
 */
/**
 * Body-inspection zones, laid out to match the printed Nawilis SPK top-view
 * diagram (viewBox 360×520). Rectangles use x/y/w/h; the 4 wheels use shape:'circle'
 * with cx/cy/r so ban/velg are selectable too.
 */
export type DamageZone = { code: string; label: string; abbr: string } & (
  | { shape?: 'rect'; x: number; y: number; w: number; h: number }
  | { shape: 'circle'; cx: number; cy: number; r: number }
);

export const DAMAGE_ZONES: ReadonlyArray<DamageZone> = [
  // ── Front ──
  { code: 'BUMPER_DEPAN', label: 'Bumper Depan', abbr: 'BUMPER', x: 80, y: 10, w: 200, h: 16 },
  { code: 'LAMBANG_DEPAN', label: 'Lambang Depan (L/R)', abbr: 'LAMBANG', x: 104, y: 28, w: 152, h: 14 },
  { code: 'GRILL', label: 'Grill', abbr: 'GRILL', x: 120, y: 44, w: 120, h: 18 },
  { code: 'KAP_MESIN', label: 'Kap Mesin', abbr: 'KAP MESIN', x: 112, y: 64, w: 136, h: 42 },
  { code: 'BODY_DEPAN', label: 'Body Depan', abbr: 'BODY DEPAN', x: 90, y: 108, w: 180, h: 16 },
  // ── Fenders (spakbor) ──
  { code: 'SPAKBOR_DEPAN_KIRI', label: 'Spakbor Depan Kiri', abbr: 'SPKB', x: 80, y: 58, w: 16, h: 48 },
  { code: 'SPAKBOR_DEPAN_KANAN', label: 'Spakbor Depan Kanan', abbr: 'SPKB', x: 264, y: 58, w: 16, h: 48 },
  { code: 'SPAKBOR_BELAKANG_KIRI', label: 'Spakbor Belakang Kiri', abbr: 'SPKB', x: 80, y: 402, w: 16, h: 48 },
  { code: 'SPAKBOR_BELAKANG_KANAN', label: 'Spakbor Belakang Kanan', abbr: 'SPKB', x: 264, y: 402, w: 16, h: 48 },
  // ── Wheels (ban + velg) — clickable circles ──
  { code: 'RODA_DEPAN_KIRI', label: 'Roda Depan Kiri (Ban/Velg)', abbr: 'BAN', shape: 'circle', cx: 40, cy: 70, r: 27 },
  { code: 'RODA_DEPAN_KANAN', label: 'Roda Depan Kanan (Ban/Velg)', abbr: 'BAN', shape: 'circle', cx: 320, cy: 70, r: 27 },
  { code: 'RODA_BELAKANG_KIRI', label: 'Roda Belakang Kiri (Ban/Velg)', abbr: 'BAN', shape: 'circle', cx: 40, cy: 450, r: 27 },
  { code: 'RODA_BELAKANG_KANAN', label: 'Roda Belakang Kanan (Ban/Velg)', abbr: 'BAN', shape: 'circle', cx: 320, cy: 450, r: 27 },
  // ── Cabin: glass ──
  { code: 'KACA_DEPAN', label: 'Kaca Depan', abbr: 'KACA', x: 122, y: 126, w: 116, h: 30 },
  { code: 'KACA_KIRI_1', label: 'Kaca Samping Kiri 1', abbr: 'KACA', x: 110, y: 160, w: 18, h: 44 },
  { code: 'KACA_KIRI_2', label: 'Kaca Samping Kiri 2', abbr: 'KACA', x: 110, y: 208, w: 18, h: 44 },
  { code: 'KACA_KIRI_3', label: 'Kaca Samping Kiri 3', abbr: 'KACA', x: 110, y: 280, w: 18, h: 44 },
  { code: 'KACA_KANAN_1', label: 'Kaca Samping Kanan 1', abbr: 'KACA', x: 232, y: 160, w: 18, h: 44 },
  { code: 'KACA_KANAN_2', label: 'Kaca Samping Kanan 2', abbr: 'KACA', x: 232, y: 208, w: 18, h: 44 },
  { code: 'KACA_KANAN_3', label: 'Kaca Samping Kanan 3', abbr: 'KACA', x: 232, y: 280, w: 18, h: 44 },
  { code: 'KACA_BELAKANG', label: 'Kaca Belakang', abbr: 'KACA', x: 122, y: 340, w: 116, h: 30 },
  // ── Cabin: doors / roof / trim ──
  { code: 'PINTU_DEPAN_KIRI', label: 'Pintu Depan Kiri', abbr: 'PINTU', x: 82, y: 160, w: 26, h: 96 },
  { code: 'PINTU_BELAKANG_KIRI', label: 'Pintu Belakang Kiri', abbr: 'PINTU', x: 82, y: 258, w: 26, h: 96 },
  { code: 'PINTU_DEPAN_KANAN', label: 'Pintu Depan Kanan', abbr: 'PINTU', x: 252, y: 160, w: 26, h: 96 },
  { code: 'PINTU_BELAKANG_KANAN', label: 'Pintu Belakang Kanan', abbr: 'PINTU', x: 252, y: 258, w: 26, h: 96 },
  { code: 'ATAP', label: 'Atap', abbr: 'ATAP', x: 132, y: 196, w: 96, h: 140 },
  { code: 'LIST_KIRI', label: 'List Kiri', abbr: 'LIST', x: 76, y: 250, w: 6, h: 20 },
  { code: 'LIST_KANAN', label: 'List Kanan', abbr: 'LIST', x: 278, y: 250, w: 6, h: 20 },
  // ── Rear ──
  { code: 'LAMBANG_BELAKANG', label: 'Lambang Belakang (L/R)', abbr: 'LAMBANG', x: 104, y: 462, w: 152, h: 14 },
  { code: 'BUMPER_BELAKANG', label: 'Bumper Belakang', abbr: 'BUMPER', x: 80, y: 486, w: 200, h: 16 },
];

export const BRANCHES: ReadonlyArray<{ code: string; name: string; type: 'NAWILIS' | 'QUICKSERV' | 'COMPANY' }> = [
  { code: 'NWL-TA17', name: 'Tanah Abang 17', type: 'NAWILIS' },
  { code: 'NWL-TA12', name: 'Tanah Abang 12', type: 'NAWILIS' },
  { code: 'NWL-RD', name: 'Radio Dalam', type: 'NAWILIS' },
  { code: 'NWL-BGR', name: 'Bogor', type: 'NAWILIS' },
  { code: 'NWL-PML', name: 'Pamulang', type: 'NAWILIS' },
  { code: 'NWL-CLG', name: 'Cilegon', type: 'NAWILIS' },
  { code: 'NWL-BKS', name: 'Bekasi', type: 'NAWILIS' },
  { code: 'NWL-PRG', name: 'Parung', type: 'NAWILIS' },
  { code: 'NWL-CPT', name: 'Ciputat', type: 'NAWILIS' },
  { code: 'NWL-CBB', name: 'Cibubur', type: 'NAWILIS' },
  { code: 'NWL-BSD', name: 'BSD', type: 'NAWILIS' },
  { code: 'NWL-LB', name: 'Lebak Bulus', type: 'NAWILIS' },
  { code: 'NWL-JTW', name: 'Jatiwarna', type: 'NAWILIS' },
  { code: 'QS-ANT', name: 'QS Antasari', type: 'QUICKSERV' },
  { code: 'QS-SRP', name: 'QS Serpong', type: 'QUICKSERV' },
  { code: 'QS-CBB1', name: 'QS Cibubur 1', type: 'QUICKSERV' },
  { code: 'QS-CBB2', name: 'QS Cibubur 2', type: 'QUICKSERV' },
  { code: 'QS-DPK', name: 'QS Depok', type: 'QUICKSERV' },
  { code: 'QS-JGL', name: 'QS Joglo', type: 'QUICKSERV' },
  { code: 'QS-KG', name: 'QS Kelapa Gading', type: 'QUICKSERV' },
  { code: 'QS-PIK2', name: 'QS PIK 2', type: 'QUICKSERV' },
  { code: 'QS-DAGO', name: 'QS Dago Bandung', type: 'QUICKSERV' },
  { code: 'QS-GR', name: 'QS Graha Raya Tangsel', type: 'QUICKSERV' },
  // The rest of Turboly's store dropdown, orderable on request (2026-08-06):
  // the second Pamulang entity and the three PT holding companies.
  { code: 'NWL-PML2', name: 'Pamulang (NMS)', type: 'NAWILIS' },
  { code: 'PT-NMB', name: 'PT. Nawilis Maju Bersama', type: 'COMPANY' },
  { code: 'PT-NMS', name: 'PT. Nawilis Maju Sejahtera', type: 'COMPANY' },
  { code: 'PT-NWL', name: 'PT. Nawilis Waskita Lestari', type: 'COMPANY' },
];

/* ── "NAWILIS CHECK and GO REPORT" — the printed sheet, as data ──────────────
 *
 * The tablet form renders from these tables and POST /api/checkgo turns the
 * stored codes back into these labels, so there is exactly ONE spelling of
 * every check. Titles and item names are VERBATIM from the paper (mixed
 * English/Indonesian on purpose): the checker holds the sheet next to the
 * tablet, and different wording reads as a different check.
 *
 * `code` is the stored identity — a label may be re-printed, a code may not
 * change or old documents stop resolving.
 */

/** Severity a choice carries; the form fills the chip with --ok/--warn/--block. */
export type CheckgoTone = 'ok' | 'warn' | 'block';

/** A reading the paper asks for as a number, with the OK-range printed inline. */
export interface CheckgoMeasure {
  /** Printed unit, straight off the sheet ("c" is not "°C" on this form). */
  unit: 'c' | '%';
  hint: string;
}

export interface CheckgoSubItem {
  code: string;
  label: string;
  /** Absent = the item is only looked at, no number is written down. */
  measure?: CheckgoMeasure;
}

export interface CheckgoSection {
  /** The number printed on the sheet — part of the name a checker reads out. */
  no: number;
  code: string;
  title: string;
  subItems: ReadonlyArray<CheckgoSubItem>;
}

/** Sections 1-4: ONE Pass/Fail verdict for the whole section, plus its items. */
export const CHECKGO_SECTIONS: ReadonlyArray<CheckgoSection> = [
  {
    no: 1,
    code: 'COOLING',
    title: 'Cooling System',
    subItems: [
      { code: 'COOLANT', label: 'Coolant', measure: { unit: 'c', hint: 'Antara -15 c dan -40 c = OK' } },
      { code: 'TUTUP_RADIATOR', label: 'Tutup Radiator' },
    ],
  },
  {
    no: 2,
    code: 'BRAKE',
    title: 'Brake System',
    subItems: [{ code: 'BRAKE_FLUID', label: 'Brake Fluid', measure: { unit: '%', hint: '0,1,2 = OK' } }],
  },
  {
    no: 3,
    code: 'POWER_STEERING',
    title: 'Power Steering System',
    subItems: [{ code: 'POWER_STEERING_FLUID', label: 'Power Steering Fluid' }],
  },
  {
    no: 4,
    code: 'AC',
    title: 'Air Conditioning System',
    subItems: [
      { code: 'AC_VENT_TEMP', label: 'AC Vent Temp', measure: { unit: 'c', hint: 'Dibawah 10 c = OK' } },
      { code: 'REFRIGERANT_R134A', label: 'Refrigerant Contamination R134a', measure: { unit: '%', hint: '100% = OK' } },
    ],
  },
];

/** The two boxes sections 1-4 carry. `value` is stored as printed. */
export const CHECKGO_VERDICTS: ReadonlyArray<{ value: string; tone: CheckgoTone }> = [
  { value: 'Pass', tone: 'ok' },
  { value: 'Fail', tone: 'block' },
];

/**
 * Section 5 is NOT pass/fail — a battery is either fine, chargeable, or dead,
 * and "RECHARGE" is a job we sell, so it may not be flattened into "Fail".
 */
export const CHECKGO_ELECTRICAL: {
  no: number;
  code: string;
  title: string;
  options: ReadonlyArray<{ code: string; label: string; tone: CheckgoTone }>;
} = {
  no: 5,
  code: 'ELECTRICAL',
  title: 'Electrical System',
  options: [
    { code: 'GOOD', label: 'GOOD (ok)', tone: 'ok' },
    { code: 'RECHARGE', label: 'RECHARGE (charge)', tone: 'warn' },
    { code: 'REPLACE', label: 'REPLACE (ganti)', tone: 'block' },
  ],
};

/**
 * Section 6 — the four wheels. The paper misprints the rear pair as "(c)"
 * twice; the codes below are a/b/c/d in reading order, the Indonesian position
 * names are exactly as printed.
 */
export const CHECKGO_TIRE: {
  no: number;
  code: string;
  title: string;
  positions: ReadonlyArray<{ code: string; label: string }>;
  flags: ReadonlyArray<{ code: string; label: string; choices?: ReadonlyArray<string> }>;
} = {
  no: 6,
  code: 'TIRE',
  title: 'Tire',
  positions: [
    { code: 'DEPAN_KIRI', label: 'Depan Kiri' },
    { code: 'DEPAN_KANAN', label: 'Depan Kanan' },
    { code: 'BELAKANG_KIRI', label: 'Belakang Kiri' },
    { code: 'BELAKANG_KANAN', label: 'Belakang Kanan' },
  ],
  // Marks printed under every wheel. Only the air mark has a sub-choice, and it
  // stays optional: the sheet is often ticked before the gauge is read.
  flags: [
    { code: 'ANGIN_TIDAK_NORMAL', label: 'Angin tidak normal', choices: ['Kurang', 'Lebih'] },
    { code: 'AUS_TIDAK_RATA', label: 'Aus tidak rata' },
    { code: 'RETAK', label: 'Retak pada ban' },
  ],
};

/**
 * The two recommendation lists at the foot of the sheet. Kept as one table so
 * the form renders both from a single loop; `freeTextLabel` marks the list the
 * paper prints its "Lain-lain :" line under.
 */
export const CHECKGO_REKOMENDASI: ReadonlyArray<{
  code: string;
  title: string;
  options: ReadonlyArray<{ code: string; label: string }>;
  freeTextLabel?: string;
}> = [
  {
    code: 'BAN',
    title: 'Rekomendasi untuk Ban',
    options: [
      { code: 'SPOORING', label: 'Spooring' },
      { code: 'BALANCING', label: 'Balancing' },
      { code: 'ROTASI_BAN', label: 'Rotasi Ban' },
      { code: 'GANTI_BAN', label: 'Ganti Ban' },
    ],
  },
  {
    code: 'UMUM',
    title: 'Rekomendasi untuk 1 - 5',
    options: [
      { code: 'KURAS_RADIATOR', label: 'Kuras Radiator' },
      { code: 'KURAS_CAIRAN_REM', label: 'Kuras Cairan Rem' },
      { code: 'KURAS_POWER_STEERING', label: 'Kuras Power Steering' },
      { code: 'FLUSHING_AC', label: 'Flushing AC' },
      { code: 'GANTI_AKI', label: 'Ganti Aki/Battery' },
    ],
    freeTextLabel: 'Lain-lain :',
  },
];
