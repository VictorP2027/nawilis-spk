import type { BranchType } from './types.js';

/**
 * Canonical reference data. These are OUR codes. The link to Turboly's real
 * store IDs and service SKUs lives in the tb_* mirror collections, populated
 * from the tenant export (seed/turboly-import.ts) — never invented here.
 */

export interface RefBranch {
  code: string;
  name: string;
  type: BranchType;
  /** Abbreviation seen in Turboly document numbers, e.g. SBO/BKS/... → "BKS". */
  docAbbrev: string | null;
  /** Best-guess Turboly store name for the import matcher; confirm via export. */
  turbolyStoreNameGuess: string;
}

export const REF_BRANCHES: readonly RefBranch[] = [
  { code: 'NWL-TA17', name: 'Tanah Abang 17', type: 'NAWILIS', docAbbrev: 'TA17', turbolyStoreNameGuess: 'Nawilis Tanah Abang 17' },
  { code: 'NWL-TA12', name: 'Tanah Abang 12', type: 'NAWILIS', docAbbrev: 'TA12', turbolyStoreNameGuess: 'Nawilis Tanah Abang 12' },
  { code: 'NWL-RD', name: 'Radio Dalam', type: 'NAWILIS', docAbbrev: 'RD', turbolyStoreNameGuess: 'Nawilis Radio Dalam' },
  { code: 'NWL-BGR', name: 'Bogor', type: 'NAWILIS', docAbbrev: 'BGR', turbolyStoreNameGuess: 'Nawilis Bogor' },
  { code: 'NWL-PML', name: 'Pamulang', type: 'NAWILIS', docAbbrev: 'PML', turbolyStoreNameGuess: 'Nawilis Pamulang' },
  { code: 'NWL-CLG', name: 'Cilegon', type: 'NAWILIS', docAbbrev: 'CLG', turbolyStoreNameGuess: 'Nawilis Cilegon' },
  { code: 'NWL-BKS', name: 'Bekasi', type: 'NAWILIS', docAbbrev: 'BKS', turbolyStoreNameGuess: 'Nawilis Bekasi' },
  { code: 'NWL-PRG', name: 'Parung', type: 'NAWILIS', docAbbrev: 'PRG', turbolyStoreNameGuess: 'Nawilis Parung' },
  { code: 'NWL-CPT', name: 'Ciputat', type: 'NAWILIS', docAbbrev: 'CPT', turbolyStoreNameGuess: 'Nawilis Ciputat' },
  { code: 'NWL-CBB', name: 'Cibubur', type: 'NAWILIS', docAbbrev: 'CBB', turbolyStoreNameGuess: 'Nawilis Cibubur' },
  { code: 'NWL-BSD', name: 'BSD', type: 'NAWILIS', docAbbrev: 'BSD', turbolyStoreNameGuess: 'Nawilis BSD' },
  { code: 'NWL-LB', name: 'Lebak Bulus', type: 'NAWILIS', docAbbrev: 'LB', turbolyStoreNameGuess: 'Nawilis Lebak Bulus' },
  { code: 'NWL-JTW', name: 'Jatiwarna', type: 'NAWILIS', docAbbrev: 'JTW', turbolyStoreNameGuess: 'Nawilis Jatiwarna' },
  { code: 'QS-ANT', name: 'QS Antasari', type: 'QUICKSERV', docAbbrev: 'ANT', turbolyStoreNameGuess: 'Nawilis QS Antasari' },
  { code: 'QS-SRP', name: 'QS Serpong', type: 'QUICKSERV', docAbbrev: 'SRP', turbolyStoreNameGuess: 'Nawilis QS Serpong' },
  { code: 'QS-CBB1', name: 'QS Cibubur 1', type: 'QUICKSERV', docAbbrev: 'CBB1', turbolyStoreNameGuess: 'Nawilis QS Cibubur 1' },
  { code: 'QS-CBB2', name: 'QS Cibubur 2', type: 'QUICKSERV', docAbbrev: 'CBB2', turbolyStoreNameGuess: 'Nawilis QS Cibubur 2' },
  { code: 'QS-DPK', name: 'QS Depok', type: 'QUICKSERV', docAbbrev: 'DPK', turbolyStoreNameGuess: 'Nawilis QS Depok' },
  { code: 'QS-JGL', name: 'QS Joglo', type: 'QUICKSERV', docAbbrev: 'JGL', turbolyStoreNameGuess: 'Nawilis QS Joglo' },
  { code: 'QS-KG', name: 'QS Kelapa Gading', type: 'QUICKSERV', docAbbrev: 'KG', turbolyStoreNameGuess: 'Nawilis QS Kelapa Gading' },
  { code: 'QS-PIK2', name: 'QS PIK 2', type: 'QUICKSERV', docAbbrev: 'PIK2', turbolyStoreNameGuess: 'Nawilis QS PIK 2' },
  { code: 'QS-DAGO', name: 'QS Dago Bandung', type: 'QUICKSERV', docAbbrev: 'DAGO', turbolyStoreNameGuess: 'Nawilis QS Dago Bandung' },
  { code: 'QS-GR', name: 'QS Graha Raya Tangsel', type: 'QUICKSERV', docAbbrev: 'GR', turbolyStoreNameGuess: 'Nawilis QS Graha Raya' },
];

export interface RefService {
  code: string;
  /** Label exactly as pre-printed on the SPK. */
  label: string;
  lineNo: number;
  /**
   * Which Turboly line section this maps to on the Service Order form:
   * 'service' (Add Service Item) | 'package' (Add Package Service) | 'sparepart'.
   * OLI and BAN carry parts, so they may split into a service + a sparepart line.
   */
  turbolySection: 'service' | 'package' | 'sparepart';
}

/** The 12 pre-printed SPK services (rows 13–14 are free/custom). */
export const REF_SERVICES: readonly RefService[] = [
  { code: 'SPOORING', label: 'SPOORING', lineNo: 1, turbolySection: 'service' },
  { code: 'BALANCING', label: 'BALANCING', lineNo: 2, turbolySection: 'service' },
  { code: 'BALANCING_ON_CAR', label: 'BALANCING ON THE CAR', lineNo: 3, turbolySection: 'service' },
  { code: 'OLI', label: 'OLI', lineNo: 4, turbolySection: 'service' },
  { code: 'ENGINE_FLUSH', label: 'ENGINE FLUSH', lineNo: 5, turbolySection: 'service' },
  { code: 'TUNE_UP_CARBON_CLEAN', label: 'TUNE UP / CARBON CLEAN', lineNo: 6, turbolySection: 'service' },
  { code: 'AUTM_TRANS_FLUSH', label: 'AUTM TRANSMISSION FLUSH', lineNo: 7, turbolySection: 'service' },
  { code: 'KURAS_RADIATOR', label: 'KURAS RADIATOR', lineNo: 8, turbolySection: 'service' },
  { code: 'SERVICE_REM', label: 'SERVICE REM / KRS MINYAK REM', lineNo: 9, turbolySection: 'service' },
  { code: 'BUBUT_REM', label: 'BUBUT REM', lineNo: 10, turbolySection: 'service' },
  { code: 'BAN', label: 'BAN', lineNo: 11, turbolySection: 'service' },
  { code: 'NITROGEN', label: 'NITROGEN', lineNo: 12, turbolySection: 'service' },
];

export interface RefConditionItem {
  code: string;
  rowNo: number;
  label: string;
  /** Allowed non-OK marks for this row (drives the checkbox UI + parser). */
  marks: readonly string[];
}

/** The 8 PENGECEKAN AWAL KENDARAAN rows. */
export const REF_CONDITION_ITEMS: readonly RefConditionItem[] = [
  { code: 'PANEL_DASHBOARD', rowNo: 1, label: 'Panel Dashboard', marks: ['PANEL_MATI'] },
  { code: 'BODY_KENDARAAN', rowNo: 2, label: 'Body Kendaraan', marks: ['BARET', 'PENYOK'] },
  { code: 'KACA_DAN_SPION', rowNo: 3, label: 'Kaca dan Spion', marks: ['BARET', 'PECAH'] },
  { code: 'VELG', rowNo: 4, label: 'Velg', marks: ['BARET', 'PENYOK'] },
  { code: 'BAUT_RODA', rowNo: 5, label: 'Baut Roda', marks: ['BARET', 'TIDAK_LENGKAP'] },
  { code: 'DOP_VELG', rowNo: 6, label: 'Dop Velg', marks: ['BARET', 'TIDAK_LENGKAP'] },
  { code: 'TUTUP_PENTIL', rowNo: 7, label: 'Tutup Pentil', marks: ['BARET', 'TIDAK_LENGKAP'] },
  { code: 'BAN_SEREP', rowNo: 8, label: 'Ban Serep', marks: ['KEMPIS', 'TIDAK_ADA'] },
];

/** Zones on the car damage diagram (evidentiary; never extracted to fields). */
export const REF_DAMAGE_ZONES: readonly string[] = [
  'BUMPER_DEPAN', 'BUMPER_BELAKANG', 'KAP_MESIN', 'GRILL', 'LAMPU_DEPAN', 'LAMPU_BELAKANG',
  'SPAKBOR_KIRI', 'SPAKBOR_KANAN', 'PINTU_KIRI', 'PINTU_KANAN', 'KACA', 'ATAP', 'BODY_DEPAN', 'LIST', 'BAN_SRP',
];

/** Car brands seen in Indonesia (incl. premium/exotic — Nawilis services them) for fuzzy matching. */
export const CAR_BRANDS: readonly string[] = [
  'TOYOTA', 'DAIHATSU', 'HONDA', 'SUZUKI', 'MITSUBISHI', 'NISSAN', 'MAZDA', 'ISUZU', 'HYUNDAI',
  'KIA', 'WULING', 'CHERY', 'DFSK', 'MG', 'BMW', 'MERCEDES-BENZ', 'AUDI', 'VOLKSWAGEN', 'LEXUS',
  'FORD', 'CHEVROLET', 'PEUGEOT', 'RENAULT', 'SUBARU', 'DATSUN', 'TATA',
  // premium / exotic
  'FERRARI', 'LAMBORGHINI', 'PORSCHE', 'MASERATI', 'BENTLEY', 'ROLLS-ROYCE', 'MCLAREN',
  'ASTON MARTIN', 'JAGUAR', 'LAND ROVER', 'RANGE ROVER', 'MINI', 'TESLA', 'VOLVO', 'ALFA ROMEO',
  'LOTUS', 'INFINITI', 'ACURA', 'CADILLAC', 'HUMMER', 'JEEP', 'DODGE', 'GMC',
  // newer market entrants
  'BYD', 'VINFAST', 'NETA', 'ORA', 'GWM', 'HAVAL', 'GEELY', 'PROTON', 'SSANGYONG', 'CITROEN',
  'FIAT', 'SKODA', 'SMART', 'OPEL', 'SEAT', 'MITSUBISHI FUSO', 'HINO',
];
