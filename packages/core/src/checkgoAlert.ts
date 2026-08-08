/**
 * The customer-facing Check & Go message.
 *
 * PURE and deterministic: an SpkDoc in, a rendered WhatsAppAlert out. No env,
 * no clock, no network — the copy is the thing most likely to be argued over,
 * so it has to be assertable in a unit test.
 *
 * What a Nawilis customer needs after a check, in this order:
 *   1. who is writing and about which car (the message arrives from a number
 *      they do not have saved),
 *   2. the findings — named, with the reading that proves them,
 *   3. that everything else was checked and is fine (a count, not a 20-line
 *      list of "Pass": listing them buries the two lines that matter),
 *   4. what we recommend, and that it has NOT been done yet,
 *   5. one way to act: reply here.
 *
 * It reads `checkGo.inspectionItems`, the flat human-readable projection the
 * intake already builds, rather than re-deriving labels from the refdata the
 * web app owns — those labels live in the app layer and change there.
 */
import type { CheckGo, CheckGoInspectionItem, SpkDoc } from './types.js';
import type { WhatsAppAlert } from './whatsapp.js';
import { parseWa } from './indonesia.js';
import { REF_BRANCHES } from './refdata.js';
import { DataError } from './failure.js';

export interface CheckGoAlertOptions {
  /** Follow-up copy: same findings, different opening and no "here are your results". */
  reminder?: boolean;
}

/**
 * Positional template variables, for operators who send through an approved
 * Meta/Twilio template instead of free text. The order is the contract with
 * the approved template body and must not be reshuffled:
 *   1 nama customer · 2 nomor polisi · 3 rekomendasi · 4 tanggal pemeriksaan ·
 *   5 cabang.
 */
type TemplateParams = [string, string, string, string, string];

/** Marks are stored as codes; these are the customer-facing phrasings. */
const TIRE_POSITION: Record<string, string> = {
  DEPAN_KIRI: 'Ban depan kiri',
  DEPAN_KANAN: 'Ban depan kanan',
  BELAKANG_KIRI: 'Ban belakang kiri',
  BELAKANG_KANAN: 'Ban belakang kanan',
};

const TIRE_FLAG: Record<string, string> = {
  ANGIN_TIDAK_NORMAL: 'tekanan angin tidak normal',
  AUS_TIDAK_RATA: 'aus tidak rata',
  RETAK: 'retak',
};

/** rowsFromReport joins the parts of a note with this. */
const NOTE_SEP = ' · ';

interface Finding {
  label: string;
  detail: string;
}

export function buildCheckGoAlert(doc: SpkDoc, opts: CheckGoAlertOptions = {}): WhatsAppAlert {
  const checkGo = doc.checkGo;
  if (!checkGo) {
    throw new DataError(`SPK ${doc._id} tidak punya data Check & Go — tidak ada hasil untuk dikirim`);
  }

  const wa = parseWa(doc.customer.waE164 ?? '');
  if (!wa.ok || !wa.e164) {
    throw new DataError(
      `nomor WhatsApp customer tidak valid ("${doc.customer.waE164 ?? ''}") — perbaiki di SPK ${doc._id} sebelum mengirim hasil Check & Go`,
    );
  }

  const plate = doc.vehicle.noPolisi.display || doc.vehicle.noPolisi.full;
  const nama = doc.customer.nama.trim() || 'Bapak/Ibu';
  const branch = branchName(doc.branchCode);
  const tanggal = formatJakartaDate(doc.capture.businessDate);
  const rekomendasi = recommendations(checkGo.inspectionItems);
  const findings = attentionList(checkGo);
  const checkedCount = checkGo.inspectionItems.filter((r) => !isRecommendationRow(r)).length;

  const reminder = opts.reminder === true;
  const lines: string[] = [
    `*${reminder ? 'PENGINGAT SERVIS NAWILIS' : 'HASIL CHECK & GO NAWILIS'}*`,
    '',
    reminder
      ? `Halo ${nama}, ini pengingat untuk rekomendasi hasil Check & Go kendaraan ${plate}.`
      : `Halo ${nama}, berikut hasil pemeriksaan kendaraan Anda.`,
    '',
    `Kendaraan: ${[plate, vehicleModel(doc)].filter(Boolean).join(' — ')}`,
    `Kilometer: ${odometer(doc)} km`,
    `Cabang: ${branch}`,
    `Tanggal pemeriksaan: ${tanggal}`,
  ];
  const checker = checkGo.mechanicName ?? doc.signatures.menerima.namaJelas ?? null;
  if (checker) lines.push(`Diperiksa oleh: ${checker}`);

  lines.push('');
  if (findings.length) {
    lines.push('*Perlu perhatian:*', ...findings.map((f) => `• ${f.label} — ${f.detail}`));
    const rest = checkedCount - findings.length;
    if (rest > 0) lines.push('', `${rest} item lain diperiksa dan dalam kondisi baik.`);
  } else {
    lines.push(`Semua ${checkedCount} item yang diperiksa dalam kondisi baik.`);
  }

  if (rekomendasi.length) {
    lines.push('', '*Rekomendasi kami:*', ...rekomendasi.map((r) => `• ${r}`));
  }

  lines.push('', closing(reminder, rekomendasi.length > 0));

  const params: TemplateParams = [
    nama,
    plate,
    rekomendasi.join(', ') || 'Pemeriksaan berkala',
    tanggal,
    branch,
  ];

  return {
    // Bare digits: Meta and wa.me take them verbatim, Twilio/WAHA re-add the '+'.
    to: wa.e164.slice(1),
    text: lines.join('\n'),
    templateParams: params,
  };
}

// ─────────────────────────────────────────────────────────────────────────

function closing(reminder: boolean, hasRecommendations: boolean): string {
  if (reminder) return 'Balas pesan ini untuk mengatur jadwal servis.';
  return hasRecommendations
    ? 'Rekomendasi di atas belum kami kerjakan. Balas pesan ini untuk mengatur jadwal servis.'
    : 'Balas pesan ini bila ada yang ingin ditanyakan.';
}

/**
 * Findings come from two places because the sheet stores them in two shapes:
 * sections carry a verdict on the flat row, tyres carry per-wheel marks that
 * only survive as codes in the report.
 */
function attentionList(checkGo: CheckGo): Finding[] {
  const findings: Finding[] = [];

  for (const row of checkGo.inspectionItems) {
    if (isRecommendationRow(row)) continue;
    const verdict = attentionVerdict(row);
    if (!verdict) continue;
    // The stored label is the printed sheet's row ("2. Sistem Pendingin Air");
    // its row number means nothing on a customer's phone.
    findings.push({ label: row.item.replace(/^\d+[.)]\s*/, ''), detail: [verdict, ...noteParts(row)].join(' ') });
  }

  // The placard standard turns a measured psi into a comparison the customer
  // can verify on their own door jamb (Chynthia's review, 8 Aug).
  const standar = checkGo.report?.tekananStandar ?? null;
  const measured = (psi: string | null | undefined): string =>
    psi ? ` (terukur ${psi} psi${standar ? `, standar placard ${standar}` : ''})` : '';

  for (const tire of checkGo.report?.tires ?? []) {
    // Stored documents span TWO sheet revisions: final-3 flags are code
    // strings, the previous revision's are {code, choice} objects. The
    // customer's phone does not care which form the branch had that week —
    // both must render (an object reaching toLowerCase took the WhatsApp
    // preview down for every pre-final-3 doc).
    const marks = (tire.flags as ReadonlyArray<string | { code?: string; choice?: string | null }>)
      .map(tireFlagLabel)
      .filter((m): m is string => m !== null);
    // Pressure is a three-way choice on the final-3 sheet; CUKUP is healthy,
    // the other two are findings the customer should hear about. "terlalu
    // tinggi"/"kurang dari standar" over the sheet's Lebih/Kurang shorthand,
    // with the measured psi and the placard standard when the checker wrote
    // them down — a bare "lebih" tells the customer nothing they can act on.
    if (tire.tekanan === 'LEBIH') marks.unshift(`tekanan angin terlalu tinggi${measured(tire.psi)}`);
    if (tire.tekanan === 'KURANG') marks.unshift(`tekanan angin kurang dari standar${measured(tire.psi)}`);
    if (!marks.length) continue;
    findings.push({ label: TIRE_POSITION[tire.position] ?? humanise(tire.position), detail: marks.join(', ') });
  }

  return findings;
}

/**
 * The mechanic's verdict wins when there is one; otherwise the checker's.
 * Matched loosely and translated: the sheet's vocabulary is checker shorthand
 * ("Fail", "REPLACE (ganti)") owned by the app layer, and an unrecognised
 * verdict must read as "checked" rather than alarm a customer wrongly.
 */
function attentionVerdict(row: CheckGoInspectionItem): string | null {
  if (row.feedback === 'fail') return 'perlu perbaikan';
  const hasil = (row.hasil ?? '').trim().toLowerCase();
  if (!hasil) return null;
  // The final-3 sheet's per-row verdict pairs, bad tone only — the healthy
  // words (bagus, jernih, tebal, rata, mati, cukup, bersih, ok) fall through
  // to null. Exact match: "tidak" as a substring would false-positive.
  const BAD: Record<string, string> = {
    kotor: 'kotor',
    tidak: 'perlu perbaikan',
    bocor: 'bocor',
    keruh: 'keruh',
    tipis: 'sudah tipis',
    nyala: 'indikator menyala',
    kurang: 'kurang',
  };
  if (BAD[hasil]) return BAD[hasil];
  // Previous sheet revisions' vocabulary — old stored docs still render.
  if (hasil.includes('replace') || hasil.includes('ganti')) return 'perlu diganti';
  if (hasil.includes('recharge')) return 'perlu di-charge';
  if (hasil.includes('fail')) return 'perlu perbaikan';
  return null;
}

/** The note repeats the verdict as its first part; keep only the readings. */
function noteParts(row: CheckGoInspectionItem): string[] {
  const hasil = (row.hasil ?? '').trim().toLowerCase();
  const parts = (row.catatan ?? '')
    .split(NOTE_SEP)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p.toLowerCase() !== hasil);
  return parts.length ? [`(${parts.join(', ')})`] : [];
}

function tireFlagLabel(flag: string | { code?: string; choice?: string | null }): string | null {
  const code = typeof flag === 'string' ? flag : flag?.code ?? '';
  if (!code) return null;
  // Legacy air mark carried its Kurang/Lebih as a sub-choice on the object —
  // rendered in the same customer wording as the current sheet's three-way.
  if (code === 'ANGIN_TIDAK_NORMAL' && typeof flag === 'object' && flag?.choice) {
    const choice = String(flag.choice).toLowerCase();
    if (choice === 'lebih') return 'tekanan angin terlalu tinggi';
    if (choice === 'kurang') return 'tekanan angin kurang dari standar';
    return `tekanan angin ${choice}`;
  }
  return TIRE_FLAG[code] ?? humanise(code);
}

/**
 * The checker's recommendations ride on the flat rows titled "Rekomendasi …",
 * and their note is already the printed label list.
 */
function recommendations(items: readonly CheckGoInspectionItem[]): string[] {
  return items
    .filter(isRecommendationRow)
    .flatMap((row) => (row.catatan ?? '').split(NOTE_SEP))
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function isRecommendationRow(row: CheckGoInspectionItem): boolean {
  return /^rekomendasi\b/i.test(row.item.trim());
}

function vehicleModel(doc: SpkDoc): string {
  return [doc.vehicle.merkNormalized ?? doc.vehicle.merkRaw, doc.vehicle.tipeNormalized]
    .filter((p): p is string => !!p && p.trim() !== '')
    .join(' ');
}

/** id-ID thousands separators — "45.230", the way the customer's odometer reads. */
function odometer(doc: SpkDoc): string {
  const value = doc.vehicle.km.value;
  if (Number.isFinite(value) && value > 0) return new Intl.NumberFormat('id-ID').format(value);
  return doc.vehicle.km.raw.trim() || '-';
}

function branchName(code: string): string {
  const branch = REF_BRANCHES.find((b) => b.code === code);
  return branch ? `Nawilis ${branch.name}` : code;
}

/**
 * businessDate is already a Jakarta calendar day; anchoring it at +07:00 keeps
 * it that day for a server running in any zone.
 */
function formatJakartaDate(ymd: string): string {
  const date = new Date(`${ymd}T00:00:00+07:00`);
  if (Number.isNaN(date.getTime())) return ymd;
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'Asia/Jakarta' }).format(date);
}

function humanise(code: string): string {
  return code.toLowerCase().replace(/_/g, ' ');
}
