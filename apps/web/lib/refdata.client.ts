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
export const DAMAGE_ZONES: ReadonlyArray<{ code: string; label: string; x: number; y: number; w: number; h: number; abbr: string }> = [
  { code: 'BUMPER_DEPAN', label: 'Bumper Depan', abbr: 'BUMPER', x: 44, y: 8, w: 112, h: 14 },
  { code: 'KAP_MESIN', label: 'Kap Mesin', abbr: 'KAP MESIN', x: 44, y: 24, w: 112, h: 40 },
  { code: 'KACA_DEPAN', label: 'Kaca Depan', abbr: 'KACA', x: 54, y: 66, w: 92, h: 22 },
  { code: 'SPAKBOR_KIRI_DPN', label: 'Spakbor Kiri Depan', abbr: 'SPKB', x: 34, y: 66, w: 18, h: 22 },
  { code: 'SPAKBOR_KANAN_DPN', label: 'Spakbor Kanan Depan', abbr: 'SPKB', x: 148, y: 66, w: 18, h: 22 },
  { code: 'PINTU_KIRI', label: 'Pintu Kiri', abbr: 'PINTU', x: 34, y: 90, w: 20, h: 96 },
  { code: 'ATAP', label: 'Atap', abbr: 'ATAP', x: 56, y: 90, w: 88, h: 96 },
  { code: 'PINTU_KANAN', label: 'Pintu Kanan', abbr: 'PINTU', x: 146, y: 90, w: 20, h: 96 },
  { code: 'KACA_BELAKANG', label: 'Kaca Belakang', abbr: 'KACA', x: 54, y: 188, w: 92, h: 22 },
  { code: 'SPAKBOR_KIRI_BLK', label: 'Spakbor Kiri Belakang', abbr: 'SPKB', x: 34, y: 188, w: 18, h: 22 },
  { code: 'SPAKBOR_KANAN_BLK', label: 'Spakbor Kanan Belakang', abbr: 'SPKB', x: 148, y: 188, w: 18, h: 22 },
  { code: 'BAGASI', label: 'Bagasi / Body Belakang', abbr: 'BAGASI', x: 44, y: 212, w: 112, h: 40 },
  { code: 'BUMPER_BELAKANG', label: 'Bumper Belakang', abbr: 'BUMPER', x: 44, y: 254, w: 112, h: 14 },
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
