import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SpkIntakeInput, collections, assignMechanic, initFlow, type SpkIntakeInputT } from '@spk/core';
import { ingestSpk } from '../../../lib/ingest';
import { triggerTurbolyPush } from '../../../lib/triggerPush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/checkgo — ingest one Check & Go (vehicle CHECK service, not a repair).
 *
 * Same pipeline as /api/spk (ingestSpk → auto-assign → instant Turboly push),
 * with the Check & Go special cases:
 *   - jobLines are ALWAYS exactly one "General Check" line:
 *     { serviceCode: 'CHECKGO', qty: 1, quotedPrice: harga, chosenSku: 'JAS-NAWJAS-GC' }
 *   - docType stored on the doc is CHECK_AND_GO
 *   - the detailed inspection checklist is stored on the doc as
 *     checkGo: { harga, inspectionItems } (Mongo keeps the full detail — Turboly
 *     only ever gets the summary), plus a fresh flow state for the flow board.
 *   - plan service time defaults to now + 30 minutes, estimasi defaults to 30.
 */

const CHECKGO_SERVICE_CODE = 'CHECKGO';
const CHECKGO_SKU = 'JAS-NAWJAS-GC';
const DEFAULT_HARGA = 100_000;
const DEFAULT_ESTIMASI_MINUTES = 30;
const PLAN_OFFSET_MINUTES = 30;

/** One optional detailed inspection row (e.g. "cooling system", "tutup radiator"). */
const InspectionItemInput = z.object({
  // Accept either key spelling from the form ("item" preferred, "name" tolerated).
  item: z.string().optional(),
  name: z.string().optional(),
  catatan: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  /** Intake result picked on the form: Baik / Perlu perbaikan / N/A. */
  hasil: z.string().nullable().optional(),
});

/**
 * Wire schema: the full SPK intake shape (same submit builder conventions as
 * the quick form) + harga General Check + optional inspection items. docType
 * from the client is accepted but ignored — the stored doc is CHECK_AND_GO.
 */
const CheckGoBody = SpkIntakeInput.omit({ docType: true, jobLines: true, capturedAt: true }).extend({
  docType: z.string().optional(),
  capturedAt: z.string().datetime().optional(),
  harga: z.coerce.number().nonnegative().default(DEFAULT_HARGA),
  inspectionItems: z.array(InspectionItemInput).default([]),
  // The mechanic picked on the form. The CODE is Turboly's store-user id — its
  // names are not unique, so the id is what a Work Order can safely be assigned
  // with later. Optional: a branch with no synced mechanics still submits.
  mechanicCode: z.string().trim().min(1).nullish(),
  mechanicName: z.string().trim().min(1).nullish(),
});

interface StoredInspectionItem {
  item: string;
  /** What the checker found at intake — distinct from `feedback`, which the
   *  mechanic fills later on the flow board. */
  hasil: string | null;
  catatan: string | null;
  /** Mechanic result, filled during the job via the flow board. */
  feedback: 'pass' | 'fail' | null;
  recommendation: string | null;
  inspected: boolean;
}

export async function POST(req: Request): Promise<Response> {
  const json = (await req.json().catch(() => null)) as { directPush?: boolean } | null;
  const parsed = CheckGoBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
  }

  const {
    harga,
    inspectionItems: rawItems,
    docType: _clientDocType,
    capturedAt,
    mechanicCode,
    mechanicName,
    ...rest
  } = parsed.data;
  void _clientDocType;
  const nowIso = new Date().toISOString();

  // Detailed rows are optional; the default is the single "Check and Go" category row.
  const inspectionItems: StoredInspectionItem[] = rawItems
    .map((r) => ({
      item: (r.item ?? r.name ?? '').trim(),
      hasil: r.hasil ?? null,
      catatan: r.catatan ?? r.note ?? null,
      feedback: null,
      recommendation: null,
      inspected: false,
    }))
    .filter((r) => r.item.length > 0);
  if (inspectionItems.length === 0) {
    inspectionItems.push({ item: 'Check and Go', hasil: null, catatan: null, feedback: null, recommendation: null, inspected: false });
  }

  // Reuse the proven SPK pipeline: build the intake with the ONE General Check
  // line; docType is corrected to CHECK_AND_GO right after the insert.
  const intake: SpkIntakeInputT = {
    ...rest,
    docType: 'SPK_NAWILIS',
    capturedAt: capturedAt ?? nowIso,
    scheduledAt: rest.scheduledAt ?? new Date(Date.now() + PLAN_OFFSET_MINUTES * 60_000).toISOString(),
    estimasiMinutes: rest.estimasiMinutes ?? DEFAULT_ESTIMASI_MINUTES,
    jobLines: [
      {
        serviceCode: CHECKGO_SERVICE_CODE,
        ordered: true,
        qty: 1,
        keterangan: 'General Check',
        quotedPrice: harga,
        chosenSku: CHECKGO_SKU,
      },
    ],
  };

  try {
    const result = await ingestSpk(intake);

    if (!result.duplicate) {
      // Stamp the Check & Go specifics BEFORE releasing to the push queue, so
      // the worker (and the flow board) always see the complete doc.
      const checkGoSet: Record<string, unknown> = {
        docType: 'CHECK_AND_GO',
        checkGo: { harga, inspectionItems, mechanicCode: mechanicCode ?? null, mechanicName: mechanicName ?? null },
        flow: initFlow(),
      };
      await collections.spk().updateOne({ _id: result.spkId }, { $set: checkGoSet });

      // Direct push (default) — same behaviour as /api/spk: release straight to
      // the Turboly queue and kick the push now. {directPush:false} holds it.
      if (json?.directPush !== false && result.state === 'awaiting_assignment') {
        // Use the mechanic the form picked; 'UNASSIGNED' only when none was
        // offered (a branch with no synced mechanics), which the flow board
        // then resolves at Buat Work Order.
        const released = await assignMechanic(result.spkId, {
          mechanicCode: mechanicCode ?? 'UNASSIGNED',
          by: 'checkgo-direct',
          via: 'console',
        });
        if (released?.state === 'queued') {
          result.state = 'queued';
          await triggerTurbolyPush(result.spkId);
        }
      }
    }

    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    console.error('checkgo ingest error', e);
    return NextResponse.json({ error: 'ingest_failed', message: (e as Error).message }, { status: 500 });
  }
}
