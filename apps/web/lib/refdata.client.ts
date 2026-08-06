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

/* ── "CHECK and GO REPORT" (final 3) — the printed sheet, as data ───────────
 *
 * Eight numbered sections, each with lettered items. Unlike the previous
 * revision there is no global Pass/Fail: every row carries its OWN verdict
 * pair, in the words printed on it (Bagus/Kotor, Jernih/Keruh, Tebal/Tipis,
 * Mati/Nyala …), and every section carries its own recommendation checklist.
 * Everything is stored as CODES — wording changes must never rewrite stored
 * documents. In every verdict pair the FIRST option is the healthy one; all
 * the rest mean the row needs attention.
 */

export interface CheckgoVerdictOpt { code: string; label: string }
export interface CheckgoReading { code: string; label: string; suffix?: string }

export interface CheckgoItem {
  code: string;
  label: string;
  /** First entry is the healthy verdict. Absent = the row only takes readings. */
  verdicts?: ReadonlyArray<CheckgoVerdictOpt>;
  /** Numbers/text the sheet wants written on this row (Tanggal, Km, °C, Kpa …). */
  readings?: ReadonlyArray<CheckgoReading>;
}

export interface CheckgoRekOpt { code: string; label: string; freeText?: boolean }

export interface CheckgoSection {
  /** The number printed on the sheet — part of the name a checker reads out. */
  no: number;
  code: string;
  title: string;
  /** Section-spanning verdict (Oli Mesin: Bagus/Kotor; ATF: Jernih/Kotor). */
  verdicts?: ReadonlyArray<CheckgoVerdictOpt>;
  items: ReadonlyArray<CheckgoItem>;
  rekomendasi: ReadonlyArray<CheckgoRekOpt>;
  /** "Part suspensi yang harus diganti: 1..5" — free lines under Lain-Lain. */
  extraList?: { label: string; count: number };
}

const OK_TIDAK: ReadonlyArray<CheckgoVerdictOpt> = [
  { code: 'OK', label: 'OK' },
  { code: 'TIDAK', label: 'Tidak' },
];

/** Sections 1-7. Section 8 (Tire/Ban) has its own shape below. */
export const CHECKGO_SECTIONS: ReadonlyArray<CheckgoSection> = [
  {
    no: 1,
    code: 'OLI_MESIN',
    title: 'Oli Mesin',
    verdicts: [
      { code: 'BAGUS', label: 'Bagus' },
      { code: 'KOTOR', label: 'Kotor' },
    ],
    items: [
      { code: 'OM_GANTI', label: 'Terakhir ganti', readings: [{ code: 'TGL', label: 'Tanggal' }, { code: 'KM', label: 'Km' }] },
      { code: 'OM_OLI', label: 'Oli yang dipakai', readings: [{ code: 'MERK_SAE', label: 'Merk/SAE' }] },
    ],
    rekomendasi: [
      { code: 'GANTI_OLI', label: 'Ganti oli' },
      { code: 'ENGINE_FLUSH', label: 'Engine Flush' },
    ],
  },
  {
    no: 2,
    code: 'PENDINGIN',
    title: 'Sistem Pendingin Air',
    items: [
      {
        code: 'PD_COOLANT', label: 'Coolant (antara -15C s/d -40C = OK)', verdicts: OK_TIDAK,
        readings: [{ code: 'TEMP', label: 'Suhu', suffix: '°C' }],
      },
      {
        code: 'PD_TUTUP', label: 'Tutup radiator',
        verdicts: [{ code: 'OK', label: 'OK' }, { code: 'BOCOR', label: 'Bocor' }],
        readings: [{ code: 'TEKANAN', label: 'Tekanan', suffix: 'Kpa' }],
      },
    ],
    rekomendasi: [
      { code: 'GANTI_COOLANT', label: 'Ganti cairan coolant' },
      { code: 'GANTI_TUTUP_RADIATOR', label: 'Ganti tutup radiator' },
    ],
  },
  {
    no: 3,
    code: 'REM',
    title: 'Sistem Rem',
    items: [
      {
        code: 'REM_MINYAK', label: 'Minyak rem (kadar air 0,1,2 = OK)', verdicts: OK_TIDAK,
        readings: [{ code: 'KADAR_AIR', label: 'Kadar Air', suffix: '%' }],
      },
      { code: 'REM_JERNIH', label: 'Kejernihan minyak rem', verdicts: [{ code: 'JERNIH', label: 'Jernih' }, { code: 'KERUH', label: 'Keruh' }] },
      { code: 'REM_KANVAS_DPN', label: 'Kanvas rem depan', verdicts: [{ code: 'TEBAL', label: 'Tebal' }, { code: 'TIPIS', label: 'Tipis' }] },
      { code: 'REM_KANVAS_BLK', label: 'Kanvas rem belakang', verdicts: [{ code: 'TEBAL', label: 'Tebal' }, { code: 'TIPIS', label: 'Tipis' }] },
      { code: 'REM_DISC', label: 'Kondisi permukaan Disc Brake / Cakram', verdicts: [{ code: 'RATA', label: 'Rata' }, { code: 'TIDAK', label: 'Tidak' }] },
    ],
    rekomendasi: [
      { code: 'KMR', label: 'Kuras Minyak Rem (KMR)' },
      { code: 'GANTI_KANVAS_DPN', label: 'Ganti kanvas rem depan' },
      { code: 'GANTI_KANVAS_BLK', label: 'Ganti kanvas rem belakang' },
      { code: 'BUBUT_DISC', label: 'Bubut Disc Brake/Cakram' },
    ],
  },
  {
    no: 4,
    code: 'ATF',
    title: 'Oli Transmisi Otomatis',
    verdicts: [
      { code: 'JERNIH', label: 'Jernih' },
      { code: 'KOTOR', label: 'Kotor' },
    ],
    items: [
      { code: 'ATF_GANTI', label: 'Terakhir ganti', readings: [{ code: 'TGL', label: 'Tanggal' }, { code: 'KM', label: 'Km' }] },
      { code: 'ATF_JERNIH', label: 'Kejernihan oli transmisi otomatis' },
    ],
    rekomendasi: [{ code: 'KURAS_ATF', label: 'Kuras oli transmisi otomatis (ATF)' }],
  },
  {
    no: 5,
    code: 'PS',
    title: 'Power Steering',
    items: [
      { code: 'PS_OLI', label: 'Oli Power Steering', verdicts: [{ code: 'JERNIH', label: 'Jernih' }, { code: 'KERUH', label: 'Keruh' }] },
      // Mati (off) is the healthy state for a warning lamp.
      { code: 'PS_EPS', label: 'Indikator lampu EPS', verdicts: [{ code: 'MATI', label: 'Mati' }, { code: 'NYALA', label: 'Nyala' }] },
    ],
    rekomendasi: [
      { code: 'KURAS_PSF', label: 'Kuras oli power steering (PSF)' },
      { code: 'PERBAIKAN', label: 'Perbaikan' },
      { code: 'SCANNER', label: 'Scanner' },
    ],
  },
  {
    no: 6,
    code: 'KELISTRIKAN',
    title: 'Sistem Kelistrikan',
    items: [
      { code: 'KL_AIR_AKI', label: 'Volume air aki', verdicts: [{ code: 'CUKUP', label: 'Cukup' }, { code: 'KURANG', label: 'Kurang' }] },
      { code: 'KL_AKI', label: 'Kelistrikan aki', verdicts: OK_TIDAK },
      { code: 'KL_LAMPU', label: 'Lampu-lampu mobil', verdicts: OK_TIDAK },
    ],
    rekomendasi: [
      { code: 'TAMBAH_AIR_AKI', label: 'Tambah air aki' },
      { code: 'GANTI_AKI', label: 'Ganti aki' },
      { code: 'GANTI_LAMPU', label: 'Ganti lampu', freeText: true },
    ],
  },
  {
    no: 7,
    code: 'LAIN',
    title: 'Lain-Lain',
    items: [
      { code: 'LL_FILTER_UDARA', label: 'Filter udara', verdicts: [{ code: 'BERSIH', label: 'Bersih' }, { code: 'KOTOR', label: 'Kotor' }] },
      { code: 'LL_FILTER_CABIN', label: 'Filter cabin/AC', verdicts: [{ code: 'BERSIH', label: 'Bersih' }, { code: 'KOTOR', label: 'Kotor' }] },
      { code: 'LL_WYPER', label: 'Wyper', verdicts: OK_TIDAK },
      { code: 'LL_SUSPENSI', label: 'Suspensi /Kaki-kaki', verdicts: OK_TIDAK },
    ],
    rekomendasi: [
      { code: 'FILTER_UDARA_BERSIHKAN', label: 'Filter udara: dibersihkan' },
      { code: 'FILTER_UDARA_GANTI', label: 'Filter udara: ganti' },
      { code: 'FILTER_CABIN_BERSIHKAN', label: 'Filter cabin/AC: dibersihkan' },
      { code: 'FILTER_CABIN_GANTI', label: 'Filter cabin/AC: ganti' },
      { code: 'GANTI_WYPER', label: 'Ganti wyper' },
    ],
    extraList: { label: 'Part suspensi yang harus diganti', count: 5 },
  },
];

/**
 * Section 8 — the four wheels. Position codes are unchanged from the previous
 * revision on purpose: stored documents and the WhatsApp alert already speak
 * them. Tire pressure is now a printed three-way choice (Lebih/Cukup/Kurang,
 * Cukup healthy), not a number; the two damage marks keep their old codes.
 */
export const CHECKGO_TIRE: {
  no: number;
  code: string;
  title: string;
  positions: ReadonlyArray<{ code: string; label: string }>;
  tekanan: ReadonlyArray<CheckgoVerdictOpt & { healthy?: boolean }>;
  flags: ReadonlyArray<{ code: string; label: string }>;
  rekomendasi: ReadonlyArray<CheckgoRekOpt>;
  /** The three blank "□ ____" lines under the tire recommendations. */
  freeLines: number;
} = {
  no: 8,
  code: 'TIRE',
  title: 'Tire/Ban',
  positions: [
    { code: 'DEPAN_KIRI', label: 'Depan Kiri' },
    { code: 'DEPAN_KANAN', label: 'Depan Kanan' },
    { code: 'BELAKANG_KIRI', label: 'Belakang Kiri' },
    { code: 'BELAKANG_KANAN', label: 'Belakang Kanan' },
  ],
  tekanan: [
    { code: 'LEBIH', label: 'Lebih' },
    { code: 'CUKUP', label: 'Cukup', healthy: true },
    { code: 'KURANG', label: 'Kurang' },
  ],
  flags: [
    { code: 'AUS_TIDAK_RATA', label: 'Aus tidak rata' },
    { code: 'RETAK', label: 'Retak pada ban' },
  ],
  rekomendasi: [
    { code: 'GANTI_BAN', label: 'Ganti Ban' },
    { code: 'ROTASI_BAN', label: 'Rotasi Ban' },
    { code: 'SPOORING', label: 'Spooring' },
    { code: 'BALANCING', label: 'Balancing' },
    { code: 'BALANCING_ON_CAR', label: 'Balancing On The Car' },
  ],
  freeLines: 3,
};
