import { z } from 'zod';

/**
 * Wire schemas for the ingest API. These validate the SHAPE of what the device
 * sends. Semantic/business validation is validation.ts (Layers 1 & 2).
 */

export const JobLineInput = z.object({
  serviceCode: z.string().min(1),
  ordered: z.boolean().default(true),
  qty: z.number().int().positive().default(1),
  keterangan: z.string().nullable().default(null),
  quotedPrice: z.number().nonnegative().nullable().default(null),
  /** Operator-chosen Turboly SKU variant (defaults to the service's default at push). */
  chosenSku: z.string().nullable().default(null),
});

export const ConditionCheckInput = z.object({
  item: z.string().min(1),
  marks: z.array(z.string()).default([]),
});

export const SpkIntakeInput = z.object({
  /** Client-generated idempotency key for the capture transition. */
  uploadId: z.string().min(8),
  docType: z.enum(['SPK_NAWILIS', 'QS_INSPECTION']).default('SPK_NAWILIS'),
  branchCode: z.string().min(1),
  captureMode: z.enum(['typed', 'photo', 'hybrid']).default('typed'),
  operatorUserId: z.string().min(1),
  operatorPinVerified: z.boolean().default(false),
  deviceBindingVerified: z.boolean().default(false),

  spkNumber: z.string().nullable().default(null),
  qrPayload: z.string().nullable().default(null),

  arrivalTime: z.string().datetime().optional(),
  /** Optional appointment: if in the future, becomes Turboly's Plan Service Date/Time. */
  scheduledAt: z.string().datetime().optional(),
  capturedAt: z.string().datetime(),

  customer: z.object({
    nama: z.string().default(''), // may be empty — warned, not blocked
    wa: z.string().nullable().default(null),
    alamat: z.string().nullable().default(null),
    kontakLain: z.string().nullable().default(null),
    turbolyCustomerId: z.string().nullable().default(null),
  }),

  vehicle: z.object({
    noPolisi: z.string().default(''), // may be empty/odd — warned, not blocked
    merk: z.string().nullable().default(null),
    tipe: z.string().nullable().default(null),
    tahun: z.number().int().nullable().default(null),
    warna: z.string().nullable().default(null),
    km: z.string(), // raw as written; parsed server-side
    /** Operator clicked the on-form confirm: create this NEW make in Turboly at push. */
    createMakeConfirmed: z.boolean().default(false),
    /** Mobil / Motor — four make names exist as BOTH; this picks the roster and
     *  Turboly's vehicle type for a brand-new vehicle. */
    kind: z.enum(['car', 'motorcycle']).default('car'),
    /**
     * Nomor rangka / VIN. Asked for on ELECTRIC vehicles only, where it is the
     * one identifier that reliably tells two otherwise identical cars apart —
     * an EV has no engine number to fall back on. Optional in the schema because
     * every petrol SPK ever captured has none; the FORM is what requires it.
     */
    vin: z.string().nullable().default(null),
  }),

  complaint: z.string().nullable().default(null),
  jobLines: z.array(JobLineInput).default([]), // may be empty — warned, not blocked
  conditionChecks: z.array(ConditionCheckInput).default([]),
  rekomendasiService: z.string().nullable().default(null),
  estimasiMinutes: z.number().int().nullable().default(null),

  serviceAdvisorName: z.string().nullable().default(null), // "Yang menerima"
  salespersonName: z.string().nullable().default(null),

  /**
   * Verbatim raw form fields for the Nawilis-schema export (oil/tyre brands,
   * per-service ket, previous-oil info, nama_cs, kontak_lainnya, etc.).
   * Stored as-is; the export maps known keys and passes the rest through.
   */
  raw: z.record(z.string(), z.unknown()).optional(),

  signatures: z
    .object({
      menyerahkanPresent: z.boolean().default(false),
      menyerahkanInkDensity: z.number().nullable().default(null),
      menyerahkanNamaJelas: z.string().nullable().default(null),
      menerimaPresent: z.boolean().default(false),
      menerimaNamaJelas: z.string().nullable().default(null),
      /** On-glass drawn signatures: small-canvas PNG data URLs (size-capped). */
      menyerahkanImage: z.string().max(300_000).nullable().default(null),
      menerimaImage: z.string().max(300_000).nullable().default(null),
    })
    .default({}),

  attachments: z
    .array(z.object({ ref: z.string(), kind: z.enum(['original', 'signature', 'damage']) }))
    .default([]),
});

export type SpkIntakeInputT = z.infer<typeof SpkIntakeInput>;
