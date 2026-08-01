/**
 * Client-safe reference data — a small static mirror of the 12 SPK services and
 * 23 branches, so the intake PWA doesn't have to import @spk/core (which pulls
 * in mongodb/playwright). Keep in sync with packages/core/src/refdata.ts.
 */
export const SERVICES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'SPOORING', label: 'Spooring' },
  { code: 'BALANCING', label: 'Balancing' },
  { code: 'BALANCING_ON_CAR', label: 'Balancing on the Car' },
  { code: 'OLI', label: 'Oli' },
  { code: 'ENGINE_FLUSH', label: 'Engine Flush' },
  { code: 'TUNE_UP_CARBON_CLEAN', label: 'Tune Up / Carbon Clean' },
  { code: 'AUTM_TRANS_FLUSH', label: 'Autm Transmission Flush' },
  { code: 'KURAS_RADIATOR', label: 'Kuras Radiator' },
  { code: 'SERVICE_REM', label: 'Service Rem / Krs Minyak Rem' },
  { code: 'BUBUT_REM', label: 'Bubut Rem' },
  { code: 'BAN', label: 'Ban' },
  { code: 'NITROGEN', label: 'Nitrogen' },
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

export const BRANCHES: ReadonlyArray<{ code: string; name: string; type: 'NAWILIS' | 'QUICKSERV' }> = [
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
];
