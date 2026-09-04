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
  { code: 'NWL-PML', name: 'Pamulang (NKM)', type: 'NAWILIS', docAbbrev: 'PML', turbolyStoreNameGuess: 'Nawilis Pamulang (NKM)' },
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
  // Requested 2026-08-06: the full Turboly store dropdown, selectable for
  // Service Orders and customer registration — the second Pamulang entity and
  // the three PT holding companies included. They were previously recorded as
  // not-a-workshop (tb_store_ignores); being orderable is a separate question
  // from being a physical outlet, and that call is the owner's. docAbbrev null
  // until a real Turboly document number reveals what it abbreviates them to.
  { code: 'NWL-PML2', name: 'Pamulang (NMS)', type: 'NAWILIS', docAbbrev: null, turbolyStoreNameGuess: 'Nawilis Pamulang (NMS)' },
  { code: 'PT-NMB', name: 'PT. Nawilis Maju Bersama', type: 'COMPANY', docAbbrev: null, turbolyStoreNameGuess: 'PT. Nawilis Maju Bersama' },
  { code: 'PT-NMS', name: 'PT. Nawilis Maju Sejahtera', type: 'COMPANY', docAbbrev: null, turbolyStoreNameGuess: 'PT. Nawilis Maju Sejahtera' },
  { code: 'PT-NWL', name: 'PT. Nawilis Waskita Lestari', type: 'COMPANY', docAbbrev: null, turbolyStoreNameGuess: 'PT. Nawilis Waskita Lestari' },
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
  /**
   * Rows 13+ were added to the form after this list was written, and a code missing
   * here defaults to `service` — which is how AKS-NAW-PEKA, a PRODUCT, ended up on a
   * service line and failed with `no Turboly match` (VERIFIED: Turboly's service
   * catalogue has no "pentil" at all; its product catalogue has "Pentil Karet").
   * PENTIL_KARET is goods, so it goes to the Service Order's sparepart section; the
   * other two are genuine jasa and were only ever right by accident.
   */
  { code: 'PENTIL_KARET', label: 'PENTIL KARET', lineNo: 13, turbolySection: 'sparepart' },
  { code: 'POWER_TUNE_UP', label: 'POWER TUNE-UP', lineNo: 14, turbolySection: 'service' },
  { code: 'OIL_FILTER', label: 'OIL FILTER', lineNo: 15, turbolySection: 'service' },
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
  { code: 'PANEL_DASHBOARD', rowNo: 1, label: 'Panel Dashboard', marks: ['SENSOR_NYALA', 'PANEL_MATI'] },
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

/**
 * Which branch a newly-appeared Turboly store belongs to — or nobody.
 *
 * Turboly's store dropdown is read on every catalogue sync, so an outlet that
 * opened yesterday is already visible; what was missing was permission to act
 * on it without a person looking up Turboly's internal store id. This decides
 * that, and it is deliberately unwilling: a wrong answer silently routes one
 * branch's orders into another branch's store, which nobody would notice until
 * the month's numbers were already wrong.
 *
 * So it answers only when the answer is beyond doubt:
 *   - the store name must equal the branch's turbolyStoreNameGuess, compared
 *     without case or punctuation ("Nawilis QS PIK 2" = "NAWILIS QS PIK2"),
 *   - exactly one branch may match — a tie is never broken,
 *   - the branch must be unmapped, so an existing branch can never be moved
 *     to a different store.
 * Every other case returns null and leaves the run's existing warning to it.
 */
const normStoreName = (s: string): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export function branchForNewStore(
  liveStoreName: string,
  mappedBranchCodes: ReadonlySet<string>,
  branches: readonly RefBranch[] = REF_BRANCHES,
): RefBranch | null {
  const want = normStoreName(liveStoreName);
  if (!want) return null;
  const hits = branches.filter(
    (b) => !mappedBranchCodes.has(b.code) && normStoreName(b.turbolyStoreNameGuess) === want,
  );
  return hits.length === 1 ? hits[0]! : null;
}
