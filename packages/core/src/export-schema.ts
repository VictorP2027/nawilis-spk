import type { SpkDoc } from './types.js';
import { canonPhoneKey } from './indonesia.js';
import { REF_BRANCHES } from './refdata.js';

/**
 * The EXACT column order of the Nawilis SPK export (from the Nawilis Parung
 * xlsx). Keep this order — downstream tooling/Turboly import expects it.
 */
export const NAWILIS_COLUMNS = [
  'id', 'timestamp', 'waktu_selesai', 'estimasi_waktu_pengerjaan', 'waktu_pengerjaan_aktual',
  'creator', 'outlet', 'nomor_antrian', 'm1', 'pekerjaan_m1', 'm2', 'pekerjaan_m2', 'm3', 'pekerjaan_m3',
  'status', 'nopol', 'nama_customer', 'nomor_WA', 'alamat', 'merek', 'tipe', 'warna', 'km', 'tahun', 'keluhan',
  'spooring_qty', 'spooring_ket', 'balancing_qty', 'balancing_ket', 'balancing_on_the_car_qty', 'balancing_on_the_car_ket',
  'engine_flush_qty', 'engine_flush_ket', 'carbon_clean_qty', 'carbon_clean_ket', 'oli_qty', 'merek_oli', 'tipe_oli',
  'automatic_transmission_flush_qty', 'automatic_transmission_flush_ket', 'radiator_qty', 'radiator_ket',
  'service_rem_qty', 'service_rem_ket', 'bubut_rem_qty', 'bubut_rem_ket', 'ban_qty', 'merek_ban', 'tipe_ban',
  'nitrogen_qty', 'nitrogen_ket', 'service_lain', 'service_lain_qty', 'service_lain_durasi', 'service_lain_ket',
  'merek_oli_sebelumnya', 'tipe_oli_sebelumnya', 'bengkel_sebelumnya', 'km_ganti_oli_sebelumnya',
  'dashboard', 'body', 'kaca_spion', 'velg', 'baut_roda', 'dop_velg', 'tutup_pentil', 'ban_serep',
  'nama_customer_menyerahkan', 'nama_cs', 'kontak_lainnya',
  // appended (not part of the original Nawilis 70): the phone-number identity key
  'pkey_phone',
] as const;

export type NawilisColumn = (typeof NAWILIS_COLUMNS)[number];

/** Our service code → the (qty, ket) column pair in the export. */
const SERVICE_COL: Record<string, { qty: NawilisColumn; ket?: NawilisColumn }> = {
  SPOORING: { qty: 'spooring_qty', ket: 'spooring_ket' },
  BALANCING: { qty: 'balancing_qty', ket: 'balancing_ket' },
  BALANCING_ON_CAR: { qty: 'balancing_on_the_car_qty', ket: 'balancing_on_the_car_ket' },
  ENGINE_FLUSH: { qty: 'engine_flush_qty', ket: 'engine_flush_ket' },
  TUNE_UP_CARBON_CLEAN: { qty: 'carbon_clean_qty', ket: 'carbon_clean_ket' },
  OLI: { qty: 'oli_qty' },
  AUTM_TRANS_FLUSH: { qty: 'automatic_transmission_flush_qty', ket: 'automatic_transmission_flush_ket' },
  KURAS_RADIATOR: { qty: 'radiator_qty', ket: 'radiator_ket' },
  SERVICE_REM: { qty: 'service_rem_qty', ket: 'service_rem_ket' },
  BUBUT_REM: { qty: 'bubut_rem_qty', ket: 'bubut_rem_ket' },
  BAN: { qty: 'ban_qty' },
  NITROGEN: { qty: 'nitrogen_qty', ket: 'nitrogen_ket' },
};

const CONDITION_COL: Record<string, NawilisColumn> = {
  PANEL_DASHBOARD: 'dashboard', BODY_KENDARAAN: 'body', KACA_DAN_SPION: 'kaca_spion', VELG: 'velg',
  BAUT_RODA: 'baut_roda', DOP_VELG: 'dop_velg', TUTUP_PENTIL: 'tutup_pentil', BAN_SEREP: 'ban_serep',
};

/** Excel serial date (days since 1899-12-30) for a given instant. */
export function excelSerial(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return ms / 86_400_000 + 25569;
}

/** Map our pipeline state to a Nawilis-style status string. */
function statusOf(doc: SpkDoc): string {
  switch (doc.state) {
    case 'confirmed': return 'SELESAI';
    case 'pushed': case 'pushing': case 'queued': return 'ON PROGRESS';
    case 'awaiting_assignment': return 'MENUNGGU';
    case 'needs_review': return 'REVIEW';
    case 'voided': case 'superseded': return 'BATAL';
    default: return doc.state.toUpperCase();
  }
}

/**
 * Build one export row from an SPK doc. Prefers structured fields; falls back to
 * the verbatim rawForm for fields with no structured home (oil/tyre brands,
 * previous-oil, nama_cs, etc.). Returns a plain object keyed by column name.
 */
export function toNawilisRow(doc: SpkDoc): Record<NawilisColumn, string | number> {
  const raw = (doc.rawForm ?? {}) as Record<string, unknown>;
  const rawStr = (k: string): string => (raw[k] == null ? '' : String(raw[k]));

  const row = Object.fromEntries(NAWILIS_COLUMNS.map((c) => [c, ''])) as Record<NawilisColumn, string | number>;

  row.id = doc._id;
  row.timestamp = excelSerial(doc.capture.receivedAt);
  row.estimasi_waktu_pengerjaan = doc.estimasi?.minutes != null ? Number((doc.estimasi.minutes / 60).toFixed(2)) : '';
  row.creator = rawStr('creator') || doc.capture.operator.userId;
  row.outlet = REF_BRANCHES.find((b) => b.code === doc.branchCode)?.turbolyStoreNameGuess ?? doc.branchCode;
  row.nomor_antrian = doc.nomorAntrian ?? '';
  row.m1 = doc.assignment?.primaryMechanicCode ?? '';
  row.pekerjaan_m1 = doc.jobLines.filter((l) => l.ordered).map((l) => l.serviceCode).join(', ');
  row.status = statusOf(doc);
  row.nopol = doc.vehicle.noPolisi.display;
  row.nama_customer = doc.customer.nama;
  row.nomor_WA = doc.customer.waE164 ?? '';
  row.pkey_phone = doc.customer.phoneKey ?? canonPhoneKey(doc.customer.waE164 ?? '');
  row.alamat = doc.customer.alamat ?? '';
  row.merek = doc.vehicle.merkNormalized ?? doc.vehicle.merkRaw ?? '';
  row.tipe = doc.vehicle.tipeNormalized ?? '';
  row.warna = doc.vehicle.warna ?? '';
  row.km = doc.vehicle.km.value ?? '';
  row.tahun = doc.vehicle.tahun ?? '';
  row.keluhan = doc.complaint.keluhan ?? '';

  // Per-service qty/ket. qty = 0 when not ordered (matches the export).
  for (const [code, cols] of Object.entries(SERVICE_COL)) {
    const line = doc.jobLines.find((l) => l.serviceCode === code);
    row[cols.qty] = line?.ordered ? line.qty : 0;
    if (cols.ket) row[cols.ket] = line?.keterangan ?? '';
  }

  // Oil / tyre brand specifics + previous-oil + service_lain come from rawForm.
  for (const k of [
    'merek_oli', 'tipe_oli', 'merek_ban', 'tipe_ban', 'service_lain', 'service_lain_qty', 'service_lain_durasi', 'service_lain_ket',
    'merek_oli_sebelumnya', 'tipe_oli_sebelumnya', 'bengkel_sebelumnya', 'km_ganti_oli_sebelumnya',
    'waktu_selesai', 'waktu_pengerjaan_aktual', 'm2', 'pekerjaan_m2', 'm3', 'pekerjaan_m3',
  ] as const) {
    if (rawStr(k)) (row as Record<string, string | number>)[k] = rawStr(k);
  }

  // Condition checks: OK, or the marked value.
  for (const c of doc.conditionChecks) {
    const col = CONDITION_COL[c.item];
    if (col) row[col] = c.status === 'OK' ? 'OK' : c.marks.join('/') || 'OK';
  }

  row.nama_customer_menyerahkan = doc.customer.nama || rawStr('nama_customer_menyerahkan');
  row.nama_cs = doc.signatures.menerima.namaJelas ?? rawStr('nama_cs');
  row.kontak_lainnya = doc.customer.kontakLain ?? rawStr('kontak_lainnya');

  return row;
}

/**
 * "Used in a Service Order" = the SPK was given to a mechanic (past the
 * awaiting_assignment gate) and thus became (or will become) a Turboly Service Order.
 */
export function isUsedInServiceOrder(doc: SpkDoc): boolean {
  return doc.assignment != null || ['queued', 'pushing', 'pushed', 'confirmed'].includes(doc.state);
}
