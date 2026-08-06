import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  SpkIntakeInput,
  collections,
  assignMechanic,
  initFlow,
  type SpkIntakeInputT,
  type CheckGo,
  type CheckGoInspectionItem,
  type CheckGoReport,
  type SpkDoc,
  buildCheckGoAlert,
  createWhatsAppClient,
} from '@spk/core';
import {
  CheckReportInput,
  intakeRow,
  normalizeReport,
  rowsFromReport,
} from '../../../lib/checkgoReport';
import { ingestSpk } from '../../../lib/ingest';
import { triggerTurbolyPush } from '../../../lib/triggerPush';
// The paper form's vocabulary lives in lib/refdata.client.ts; everything that
// resolves codes against it goes through lib/checkgoReport.ts now, so the
// route itself no longer touches the tables.

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
 *   - the inspection checklist is stored on the doc as checkGo: { harga,
 *     report, inspectionItems } (Mongo keeps the full detail — Turboly only
 *     ever gets the summary), plus a fresh flow state for the flow board.
 *   - plan service time defaults to now + 30 minutes, estimasi defaults to 30.
 */

const CHECKGO_SERVICE_CODE = 'CHECKGO';
const CHECKGO_SKU = 'JAS-NAWJAS-GC';
const DEFAULT_HARGA = 100_000;
const DEFAULT_ESTIMASI_MINUTES = 30;
const PLAN_OFFSET_MINUTES = 30;

/**
 * One free-typed inspection row. Still accepted because /checkgo/sheet writes
 * its rows by hand; /checkgo now sends `checkReport` instead.
 */
const InspectionItemInput = z.object({
  // Accept either key spelling from the form ("item" preferred, "name" tolerated).
  item: z.string().optional(),
  name: z.string().optional(),
  catatan: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  /** Whatever the checker recorded as the finding on that row. */
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
  checkReport: CheckReportInput.nullish(),
  // The mechanic picked on the form. The CODE is Turboly's store-user id — its
  // names are not unique, so the id is what a Work Order can safely be assigned
  // with later. Optional: a branch with no synced mechanics still submits.
  mechanicCode: z.string().trim().min(1).nullish(),
  mechanicName: z.string().trim().min(1).nullish(),
});

export async function POST(req: Request): Promise<Response> {
  const json = (await req.json().catch(() => null)) as { directPush?: boolean } | null;
  const parsed = CheckGoBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
  }

  const {
    harga,
    inspectionItems: rawItems,
    checkReport,
    docType: _clientDocType,
    capturedAt,
    mechanicCode,
    mechanicName,
    ...rest
  } = parsed.data;
  void _clientDocType;
  const nowIso = new Date().toISOString();

  const report = checkReport ? normalizeReport(checkReport) : null;

  // Rows from the paper report come first — they are the sheet's walking order.
  // Hand-typed rows (/checkgo/sheet) follow. Both are optional; the default is
  // still the single "Check and Go" category row.
  const inspectionItems: CheckGoInspectionItem[] = [
    ...(report ? rowsFromReport(report) : []),
    ...rawItems
      .map((r) => intakeRow((r.item ?? r.name ?? '').trim(), r.hasil ?? null, r.catatan ?? r.note ?? null))
      .filter((r) => r.item.length > 0),
  ];
  if (inspectionItems.length === 0) {
    inspectionItems.push(intakeRow('Check and Go', null, null));
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
      // Typed as CheckGo (not an inline object literal) so this write is checked
      // against SpkDoc — the shape used to drift here precisely because it wasn't.
      const checkGo: CheckGo = {
        harga,
        inspectionItems,
        report,
        mechanicCode: mechanicCode ?? null,
        mechanicName: mechanicName ?? null,
      };
      const checkGoSet: Record<string, unknown> = {
        docType: 'CHECK_AND_GO',
        checkGo,
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

      // Tell the customer what we found. LAST, and awaited: last because a
      // gateway outage must never cost us the intake that is already safely in
      // Mongo, awaited because this runs in a serverless function that stops
      // executing the moment the response is returned — a fire-and-forget send
      // would be killed mid-flight and look like it had worked.
      await sendCheckGoAlert(result.spkId);
    }

    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    console.error('checkgo ingest error', e);
    return NextResponse.json({ error: 'ingest_failed', message: (e as Error).message }, { status: 500 });
  }
}

/**
 * Send the customer their Check & Go result over WhatsApp, and record what
 * happened on the doc.
 *
 * NEVER THROWS. The alert is a courtesy on top of an intake that has already
 * succeeded; letting a dead gateway turn a saved inspection into an HTTP 500
 * would make the tablet operator re-submit and create a duplicate. Every
 * outcome — sent, manual-link fallback, refused, crashed — lands in
 * `checkGo.alert` instead, which is the only place staff can later find out
 * that a customer was not actually messaged.
 */
async function sendCheckGoAlert(spkId: string): Promise<void> {
  // Off unless explicitly switched on. This messages REAL customers, so the
  // safe state is silence: a branch that configures WhatsApp credentials for
  // testing must not start sending to the 23 branches' customers as a side
  // effect. Opt-in, never opt-out.
  if (process.env.CHECKGO_ALERT_ENABLED !== 'true') return;

  const stamp = async (alert: Record<string, unknown>): Promise<void> => {
    await collections
      .spk()
      .updateOne({ _id: spkId }, { $set: { 'checkGo.alert': { ...alert, at: new Date().toISOString() } } })
      .catch(() => undefined);
  };

  try {
    // Re-read rather than reuse the in-memory intake: the alert quotes the
    // stored inspection rows, so it must quote what was actually persisted.
    const doc = (await collections.spk().findOne({ _id: spkId })) as SpkDoc | null;
    if (!doc) return;

    const alert = buildCheckGoAlert(doc);
    const client = createWhatsAppClient();
    const res = await client.sendReport(alert);
    await stamp({
      mode: res.mode,
      provider: client.provider,
      to: alert.to,
      providerMessageId: res.providerMessageId ?? null,
      whatsappUrl: res.whatsappUrl ?? null,
      skipped: res.skipped ?? false,
      reason: res.reason ?? null,
    });
  } catch (e) {
    // A DataError here is usually an unusable customer number — real, worth
    // seeing on the doc, and not worth a retry.
    console.error('checkgo whatsapp alert failed', spkId, e);
    await stamp({ mode: 'failed', error: (e as Error).message.slice(0, 300) });
  }
}
