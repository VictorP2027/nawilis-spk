import { collections, transition, loadMirror, type SpkDoc } from '@spk/core';
import { buildTurbolyPayload, planFromNowWib, formatDateWib, formatTimeWib, fillServiceOrderInspection, inspectionRowsFromCheckGo, type AppendTarget } from '@spk/core/turboly';
import type { BranchSinks } from './sessions.js';
import { config } from './config.js';

/**
 * The proven, Redis-free push path — drains `queued` SPKs until the queue is
 * empty or the budget runs out.
 *
 * This is the exact sequence validated live (created SRO/BKS/26080002+3):
 *   CAS queued→pushing → build payload (future plan time) → RPA push →
 *   pushed → independent read-back → confirmed.
 *
 * Both entrypoints share it: `push-once` runs it once and exits; `push-loop`
 * runs it forever on a poll interval. Neither needs BullMQ/Redis.
 */

const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export interface RunResult {
  candidates: number;
  pushed: number;
  confirmed: number;
  failed: number;
}

/**
 * push.yml caps the job at 60 minutes. Stop CLAIMING new orders at 50 so the
 * process finishes on its own terms: a runner killed mid-push leaves its doc
 * stranded in `pushing` until the 15-minute orphan reclaim below notices.
 */
const DEFAULT_BUDGET_MS = 50 * 60_000;

type Mirror = Awaited<ReturnType<typeof loadMirror>>;

/** How long a same-car Check & Go may sit in queued/pushing before an SPK stops waiting for it. */
const MERGE_HOLD_MAX_MS = 30 * 60_000;
/** A held SPK is looked at again after this long (one cron tick). */
const MERGE_HOLD_RECHECK_MS = 5 * 60_000;

export interface MergeDecision {
  /** Append onto this Check & Go's Service Order. */
  target: { spkId: string; serviceOrderUrl: string; serviceOrderNo: string | null } | null;
  /** The same car's Check & Go is still being pushed: come back next pass rather than race it into two orders. */
  hold: { spkId: string; state: string } | null;
  /** Why neither, when a Check & Go for the plate did exist. */
  note: string | null;
}

/**
 * ONE CAR, ONE SERVICE ORDER (Jane, Turboly, 2026-08-18: "if same car then
 * should be 1 SRO"). Find the Check & Go this SPK belongs to, if any.
 *
 * "Same car" is the exact no-space plate at the same branch, inside the merge
 * window. plateVariants is only the INDEX key: OCR variants of two different
 * plates can share one, so the decision is made on vehicle.noPolisi.full and
 * never on the variant hit alone. Only a Check & Go that has actually reached
 * Turboly (pushed/confirmed, with the order URL) is a target; one still queued
 * or pushing is a HOLD — pushing the SPK now would race it into two orders,
 * which is the exact thing this exists to prevent. A Check & Go that already
 * has an invoice is a closed visit and gets no lines.
 */
/** A plate that can identify one physical car: area + number + optional suffix. Placeholders ("BARU", "XXX", "-") never merge. */
const REAL_PLATE = /^[A-Z]{1,2}\d{1,4}[A-Z]{0,3}$/;

export async function findCheckGoMergeTarget(doc: SpkDoc, windowHours: number, now = Date.now()): Promise<MergeDecision> {
  const none: MergeDecision = { target: null, hold: null, note: null };
  const full = doc.vehicle?.noPolisi?.full ?? '';
  if (!full || !REAL_PLATE.test(full)) return none;
  // Whichever half of the visit arrives SECOND joins the first one's order.
  // Turboly's own staff say the SPK is normally submitted first and the Cek n
  // Go follows, but the pipeline cannot rely on that: either document can win
  // the race, so each looks for the other kind.
  const isCheckGo = String(doc.docType) === 'CHECK_AND_GO';
  const otherKind = isCheckGo ? { docType: { $ne: 'CHECK_AND_GO' as const } } : { docType: 'CHECK_AND_GO' as const };
  const kindLabel = isCheckGo ? 'SPK' : 'Check & Go';
  // The window is anchored on THIS SPK's own capture, not on the clock at push
  // time. An SPK captured Monday that only pushes Tuesday (a day-long outage,
  // or a human requeue) must not land on the Check & Go of Tuesday's visit:
  // that would put Monday's repair on a brand-new order and leave Monday's own
  // order empty. Only a Check & Go from at-or-before this SPK can be its visit.
  const anchor = Date.parse(doc.createdAt) || now;
  const since = new Date(anchor - windowHours * 3600_000).toISOString();
  const keys = doc.vehicle.plateVariants?.length ? doc.vehicle.plateVariants : [full];
  const cands = (await collections
    .spk()
    .find(
      {
        ...otherKind,
        branchCode: doc.branchCode,
        'vehicle.plateVariants': { $in: keys },
        createdAt: { $gte: since, $lte: doc.createdAt },
        _id: { $ne: doc._id },
      },
      { sort: { createdAt: -1 }, limit: 8 },
    )
    .toArray()) as SpkDoc[];
  const same = cands.filter((c) => (c.vehicle?.noPolisi?.full ?? '') === full);
  if (!same.length) return none;

  // Newest first — the newest Check & Go for the car is the visit this SPK
  // belongs to, and an older finished one must never beat a newer one still in
  // flight. But a newest candidate that can never carry lines (its own push
  // died for good) must not VETO an older one whose order is open and waiting:
  // that veto is how one car quietly ends up with two orders.
  let note: string | null = null;
  for (const c of same) {
    const url = c.turboly?.serviceOrderUrl ?? null;
    if ((c.state === 'confirmed' || c.state === 'pushed') && url && /\/service_orders\/\d+/.test(url)) {
      if (c.flow?.invoice) {
        note ??= `${kindLabel} ${c._id} sudah berinvoice — kunjungan itu sudah ditutup`;
        continue; // a closed visit is not this SPK's order; an older open one still might be
      }
      // A Work Order already made from that SO was made from the lines it had
      // at that moment. Merging is still right — one car, one SRO, and a second
      // SRO could never be deleted — but the WO will not grow a line by itself,
      // so this has to be said out loud.
      const woNote = c.flow?.wo
        ? `SO ${kindLabel} ${c._id} sudah punya Work Order ${c.flow.workOrderNo ?? ''} — baris baru masuk ke SO, minta cabang menambahkannya juga ke WO`.trim()
        : null;
      return { target: { spkId: c._id, serviceOrderUrl: url, serviceOrderNo: c.turboly?.serviceOrderNo ?? null }, hold: null, note: woNote ?? note };
    }
    if (c.state === 'queued' || c.state === 'pushing' || (c.state === 'failed' && c.push?.failureClass === 'transient')) {
      // In flight, or between two automatic retries of a vendor blip: wait for
      // it. How long this SPK has been waiting is tracked on the SPK itself
      // (push.mergeHoldSince) — the candidate's updatedAt is rewritten by every
      // retry, so a Check & Go that keeps failing would be "fresh" forever.
      return { target: null, hold: { spkId: c._id, state: c.state }, note };
    }
    // Data-failed, parked for a human, voided: this candidate will never carry
    // lines. Say so once and keep looking at the older ones.
    note ??= `${kindLabel} ${c._id} berstatus ${c.state}${c.turboly?.serviceOrderUrl ? '' : ' tanpa URL SO'} — tidak bisa digabung`;
  }
  return { target: null, hold: null, note };
}

/**
 * A Check & Go's findings belong in the Service Order's Inspection List — the
 * list Turboly prints and reports on, and the thing the branch actually reads.
 *
 * Takes the order to write to as an argument, because that order is no longer
 * always the one this document created: when the SPK was submitted first (which
 * Turboly says is the normal order of events), the Check & Go merges into the
 * SPK's order and its list has to land THERE.
 *
 * Called LAST, after the document's state is already decided. It is a raw-HTTP
 * call that logs in again, and Turboly allows one session per user, so it can
 * kick the Playwright session out from under whatever runs next. A missing
 * Inspection List is a gap in the ERP's notes; a lost Service Order is not
 * recoverable — hence this order of operations. A failure is stamped on the
 * document (not only logged) so the board can offer a re-fill.
 */
async function fillInspectionsFor(doc: SpkDoc, serviceOrderUrl: string | null, log: (m: string) => void): Promise<void> {
  const checkGo = (doc as { checkGo?: { inspectionItems?: Array<{ item: string; hasil?: string | null; catatan: string | null; feedback?: string | null; inspected?: boolean }> } }).checkGo;
  const soId = /\/service_orders\/(\d+)/.exec(serviceOrderUrl ?? '')?.[1];
  if (String(doc.docType) !== 'CHECK_AND_GO' || !soId || (checkGo?.inspectionItems?.length ?? 0) === 0) return;
  try {
    const rows = inspectionRowsFromCheckGo(checkGo!.inspectionItems!);
    await fillServiceOrderInspection(
      { baseUrl: config.turbolyBaseUrl, username: process.env.TURBOLY_USERNAME ?? '', password: process.env.TURBOLY_PASSWORD ?? '' },
      soId,
      rows,
      'NAWILIS CHECK & GO',
    );
    await collections
      .spk()
      .updateOne({ _id: doc._id }, { $set: { 'checkGo.inspectionsFilledAt': new Date().toISOString() }, $unset: { 'checkGo.inspectionError': '' } })
      .catch(() => {});
    log(`  ✓ inspection list terisi (${rows.length} baris) di SO ${soId}`);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    // Stamped, not just logged: without this the only record of a missing
    // inspection list is a CI log line, and the branch finds out when a
    // customer asks for the report.
    await collections.spk().updateOne({ _id: doc._id }, { $set: { 'checkGo.inspectionError': msg } }).catch(() => {});
    log(`  ⚠ inspection list gagal diisi (SO tetap utuh): ${msg}`);
  }
}

/** Process every `queued` SPK (or a single `onlyId`). Returns per-run counts. */
export async function pushQueued(
  branchSinks: BranchSinks,
  opts: { workerId?: string; onlyId?: string; limit?: number; budgetMs?: number; log?: (m: string) => void } = {},
): Promise<RunResult> {
  const workerId = opts.workerId ?? 'push-runner';
  const log = opts.log ?? (() => {});
  const out: RunResult = { candidates: 0, pushed: 0, confirmed: 0, failed: 0 };
  const pageSize = opts.limit ?? 25;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

  // A queued doc whose push.nextAttemptAt is in the FUTURE is a doc that asked
  // to be left alone for a while — an SPK holding for its car's Check & Go to
  // finish (see the merge branch). Fresh docs carry nextAttemptAt=now or null,
  // so this changes nothing for them. Same $or shape as the flow queue.
  const dueNow = () => ({
    $or: [{ 'push.nextAttemptAt': null }, { 'push.nextAttemptAt': { $exists: false } }, { 'push.nextAttemptAt': { $lte: new Date().toISOString() } }],
  });
  const fetchBatch = () =>
    collections
      .spk()
      .find(opts.onlyId ? { _id: opts.onlyId } : { state: 'queued' as const, ...dueNow() })
      .limit(pageSize)
      .toArray();

  /**
   * loadMirror is four queries, and three of them are full collection scans —
   * tb_service_products / tb_mechanics / service_sku_map carry no index (see
   * ensureIndexes, which only indexes spk/vehicles/events/dlq). Running it once
   * per DOCUMENT meant a 25-doc pass paid 100 queries and 75 scans for data
   * that is identical whenever the docs share a branch, which they usually do.
   * Cached per CALL and never at module scope: sync.yml rewrites the tb_*
   * mirror hourly and push-loop lives for days, so a longer-lived cache would
   * keep pushing yesterday's advisors.
   */
  const mirrors = new Map<string, Promise<Mirror>>();
  const mirrorFor = (branchCode: string): Promise<Mirror> => {
    let m = mirrors.get(branchCode);
    if (!m) {
      // Drop a rejected load so the next doc retries instead of inheriting a
      // cached failure from one bad Atlas moment.
      m = loadMirror(branchCode, { withProductSkus: true }).catch((e: unknown) => {
        mirrors.delete(branchCode);
        throw e;
      });
      mirrors.set(branchCode, m);
    }
    return m;
  };

  // Requeue transient failures that are due for retry (bounded). Data failures
  // (no Turboly match, bad SKU) are left for a human — retrying won't help.
  const MAX_ATTEMPTS = 5;
  let docs: Awaited<ReturnType<typeof fetchBatch>>;
  if (opts.onlyId) {
    docs = await fetchBatch();
  } else {
    const nowIso = new Date().toISOString();
    // Reclaim orphans: a runner killed mid-push (job timeout, crash) leaves its
    // doc in `pushing` with a dead lease — nothing else ever touches it. Any
    // pushing doc untouched for 15+ minutes has no living runner (leases are
    // far shorter); CAS it back to queued so this run re-pushes it.
    const staleIso = new Date(Date.now() - 15 * 60_000).toISOString();
    // Three independent reads that used to run back-to-back. Every one is a
    // fresh Atlas round trip on a cold runner, and they sit in front of the
    // first Turboly byte, so they go together. The queued read rides along
    // speculatively: on a pass with nothing to requeue — nearly all of them —
    // its result IS the batch and the re-read below never happens.
    const [retryable, orphans, queuedNow] = await Promise.all([
      collections
        .spk()
        .find({ state: 'failed', 'push.attempt': { $lt: MAX_ATTEMPTS }, 'push.nextAttemptAt': { $lte: nowIso }, 'push.failureClass': { $nin: ['data'] } })
        .limit(pageSize)
        .toArray(),
      collections.spk().find({ state: 'pushing', updatedAt: { $lt: staleIso } }).limit(pageSize).toArray(),
      fetchBatch(),
    ]);
    // Independent CAS updates on distinct _ids — serialising them cost a round
    // trip each (up to 50 of them) and bought no ordering guarantee.
    const revived = await Promise.all([
      ...retryable.map((d) =>
        transition(d._id, 'failed', 'queued', {})
          .then((r) => (r ? `↻ requeued ${d._id} (attempt ${d.push.attempt}, was ${d.push.failureClass ?? '?'})` : null))
          .catch(() => null),
      ),
      ...orphans.map((d) =>
        // Mark it: a doc that outlived its lease may have been saved in Turboly
        // already, and the claim path must not create a second order for it.
        transition(d._id, 'pushing', 'queued', { push: { ...d.push, reclaimed: true } })
          .then((r) => (r ? `↻ reclaimed orphan ${d._id} (pushing since ${d.updatedAt} — runner died mid-push)` : null))
          .catch(() => null),
      ),
    ]);
    for (const m of revived) if (m) log(m);
    docs = revived.some(Boolean) ? await fetchBatch() : queuedNow;
  }

  /**
   * Docs already attempted by THIS call. The re-read below asks the same
   * question again, so anything we could not claim (lost CAS) would otherwise
   * come back forever — this is what makes the drain terminate.
   */
  const seen = new Set<string>();
  let warmed = false;
  let budgetHit = false;

  for (;;) {
    const batch = docs.filter((d) => !seen.has(d._id));
    if (batch.length === 0) break;
    out.candidates += batch.length;

    for (let i = 0; i < batch.length; i++) {
      const doc = batch[i]!;
      seen.add(doc._id);
      if (Date.now() >= deadline) {
        log(`· time budget reached — ${batch.length - i} left for the next run`);
        budgetHit = true;
        break;
      }
      if (doc.state !== 'queued') { log(`· skip ${doc._id} (state=${doc.state})`); continue; }
      const epoch = doc.push.lease.epoch + 1;
      const leaseExpiresAt = Date.now() + config.leaseTtlMs;
      const claimed = await transition(doc._id, 'queued', 'pushing', {
        push: { ...doc.push, attempt: doc.push.attempt + 1, lease: { workerId, epoch, expiresAt: new Date(leaseExpiresAt).toISOString() } },
      });
      if (!claimed) { log(`· skip ${doc._id} (lost CAS)`); continue; }

      // Launch the browser NOW, in parallel with the mirror load and payload
      // build below. chromium.launch + newContext(storageState) is entirely
      // local — not one byte reaches Turboly until pushServiceOrder logs in —
      // so this neither kicks a live session nor breaks "empty passes never
      // touch Turboly": it only starts after a doc has actually been claimed,
      // which also guarantees it warms the branch we are about to push.
      if (!warmed) {
        warmed = true;
        void branchSinks.withSink(claimed.branchCode, async () => {}).catch(() => {});
      }

      try {
        const mirror = await mirrorFor(claimed.branchCode);
        if (!mirror.store) throw new Error(`store ${claimed.branchCode} not in mirror (run seed:turboly)`);
        // Advisor: exact mirror match wins; otherwise pass the TYPED name through so
        // the RPA tries it as a Turboly label. NEVER auto-pick a random advisor —
        // with no/unknown name the SO field is left at Turboly's own default
        // (misattributed sales credit is worse than an unfilled field).
        const typedAdvisor = (claimed.signatures.menerima.namaJelas ?? '').trim();
        const advisor =
          mirror.advisorByName.get(norm(typedAdvisor)) ??
          { _id: 'unmatched', mechanicCode: 'unmatched', name: typedAdvisor, storeCode: null, role: 'advisor', syncedAt: '' };
        if (!mirror.advisorByName.get(norm(typedAdvisor))) {
          log(`  · advisor "${typedAdvisor || '(kosong)'}" not matched — leaving Turboly's advisor field untouched`);
        }
        // Plan Service Date/Time: a FUTURE appointment (scheduledAt) wins; else
        // walk-in semantics = now+30min WIB (Turboly requires plan time > "now").
        const sched = claimed.scheduledAt && Date.parse(claimed.scheduledAt) > Date.now() + 5 * 60_000 ? claimed.scheduledAt : null;
        const plan = sched
          ? { date: formatDateWib(sched), time: formatTimeWib(sched) }
          : planFromNowWib(30);
        // Salesperson may be a SEPARATE Turboly list (e.g. NWL-BGR): use the form's
        // salesperson when given, else the advisor name; exact-match only — never
        // auto-pick (same policy as advisor).
        const typedSales = (claimed.salespersonName ?? '').trim() || typedAdvisor;
        const salesperson =
          mirror.salespersonByName.get(norm(typedSales)) ??
          { _id: 'unmatched', mechanicCode: 'unmatched', name: typedSales, storeCode: null, role: 'salesperson', syncedAt: '' };
        const payload = buildTurbolyPayload({ doc: claimed, store: mirror.store, serviceProducts: mirror.serviceProducts, productSkus: mirror.productSkus, serviceAdvisor: advisor, salesperson, planServiceDate: plan.date, planServiceTime: plan.time });

        // VERIFY BEFORE RECREATE. A retry means a previous attempt already ran,
        // and the one thing we cannot know is whether it died before or AFTER
        // Turboly committed the Save — an orphan reclaimed from `pushing` is
        // exactly that case. Pushing blind there creates a SECOND order for one
        // SPK, the worst outcome this pipeline has. The correlation token is on
        // the order, so ask first; only a doc on its first attempt may skip this.
        const wasReclaimed = (claimed.push as { reclaimed?: boolean }).reclaimed === true;
        // A merge attempt that did NOT fall back had already typed into — and
        // possibly saved onto — the Check & Go's order. Its transient failure
        // refunds the attempt, so `attempt > 1` would never become true and the
        // check below would be skipped on precisely the doc that most needs it.
        const triedMerge = Boolean(claimed.push.mergeAttempt) && claimed.push.mergeAttempt?.fellBack !== true;
        if (claimed.push.attempt > 1 || wasReclaimed || triedMerge) {
          const prior = await branchSinks
            .withSink(claimed.branchCode, (sink) => sink.verifyByToken(claimed))
            .catch(() => null);
          if (prior?.found) {
            // The order that carries our token may be the same car's Check &
            // Go order (an append that committed and died before recording):
            // then this doc is a merged one and must say so, or the board would
            // offer it flow steps against an order URL it does not hold.
            // Which order is it? If the token turned up on the same car's Check
            // & Go order, this doc is a MERGED one and must say so, or the board
            // would offer it flow steps against an order it does not hold.
            //
            // Matched on the order URL, never on the document number: mongo.ts
            // says in as many words that SRO/… numbers are recycled by tenant
            // renumbering and sandbox resets, which is why the unique index is
            // on the URL. Matching on the number could null out the real
            // serviceOrderUrl of a doc that owns its own order.
            const priorUrl = (prior.serviceOrderUrl ?? '').replace(/[#?].*$/, '') || null;
            const owner =
              config.mergeIntoCheckGo && priorUrl
                ? await collections.spk().findOne(
                    { _id: { $ne: doc._id }, docType: 'CHECK_AND_GO', branchCode: claimed.branchCode, 'turboly.serviceOrderUrl': priorUrl },
                    { projection: { _id: 1, 'turboly.serviceOrderUrl': 1 } },
                  )
                : null;
            const adopted = {
              ...claimed.turboly,
              serviceOrderNo: prior.serviceOrderNo ?? claimed.turboly.serviceOrderNo,
              ...(owner?.turboly?.serviceOrderUrl
                ? { serviceOrderUrl: null, mergedInto: { spkId: owner._id, serviceOrderUrl: owner.turboly.serviceOrderUrl, serviceOrderNo: prior.serviceOrderNo ?? null, at: new Date().toISOString() } }
                : // Not a merge: keep (or recover) this doc's OWN order URL, so
                  // the next SPK for this car can still merge into it instead of
                  // opening the second order.
                  priorUrl && !claimed.turboly.serviceOrderUrl
                  ? { serviceOrderUrl: priorUrl }
                  : {}),
            };
            if (owner) await collections.spk().updateOne({ _id: owner._id }, { $addToSet: { 'checkGo.mergedSpkIds': doc._id } }).catch(() => {});
            await transition(doc._id, 'pushing', 'pushed', { turboly: adopted }).catch(() => {});
            await transition(doc._id, 'pushed', 'confirmed', {
              turboly: { ...adopted, readback: { matchedOn: ['reference_token'], lineCount: prior.lineCount, lineSkus: prior.lineSkus, km: prior.km } },
            }).catch(() => {});
            out.pushed++;
            out.confirmed++;
            log(`✓ ${doc._id} sudah ada di Turboly (${prior.serviceOrderNo ?? '?'}) — diadopsi, tidak dibuat ulang`);
            // The push that created this order died before it could fill the
            // inspection list, and nothing else ever retried it: a Check & Go
            // adopted this way used to end up confirmed with an empty list.
            if (!(claimed as { checkGo?: { inspectionsFilledAt?: string } }).checkGo?.inspectionsFilledAt) {
              await fillInspectionsFor(claimed, adopted.mergedInto?.serviceOrderUrl ?? adopted.serviceOrderUrl ?? priorUrl, log);
            }
            continue;
          }
          if (wasReclaimed) {
            // "Not found" is NOT proof of absence here: without a stored URL the
            // read-back falls back to a list search that can simply miss. A
            // reclaimed doc whose order we cannot SEE has an unknown outcome, and
            // pushing on unknown is how one SPK becomes two Service Orders —
            // which is exactly what happened when this path pushed blind. A human
            // checks Turboly; that is cheap, a duplicate order is not.
            await transition(doc._id, 'pushing', 'manual_intervention', {
              push: {
                ...claimed.push,
                failureClass: 'structural',
                lastError:
                  'Runner mati saat push dan Service Order-nya tidak ditemukan lagi — CEK MANUAL di Turboly (cari nomor referensi SPK ini). Jangan push ulang sebelum yakin ordernya belum ada.',
              },
            }).catch(() => {});
            out.failed++;
            log(`⚠ ${doc._id}: orphan tidak bisa diverifikasi — dipindah ke manual_intervention (hindari order dobel)`);
            continue;
          }
        }

        // ── ONE CAR, ONE SERVICE ORDER ───────────────────────────────────
        // A Check & Go already opened this car's order today; the SPK's lines
        // belong on it, not on a second one. Every exit below that is not a
        // clean append either continues to the create path — ONLY when the
        // sink says nothing irreversible happened — or parks the doc.
        // A booked FUTURE appointment is a visit of its own, and a goods-only
        // payload has no service line to carry the identity token — neither
        // is merged; both get their own order exactly as before.
        //
        // Both document kinds are eligible. Turboly's staff say the SPK is
        // normally submitted first and the Cek n Go follows, so the common case
        // is a CHECK_AND_GO joining an SPK's order — bringing its General Check
        // line AND its inspection list onto that one SRO.
        //
        // WHICH document gives way? The Check & Go. The SPK keeps doing exactly
        // what it does today — it creates its own Service Order — because it is
        // the document the branch builds the job on, and because a working
        // production path should not change without a reason. The Cek n Go is
        // the second visitor to the car, so it is the one that joins.
        // (The opposite direction — an SPK joining a Check & Go's order — is
        // implemented and tested too, but stays OFF unless MERGE_INTO_CHECKGO_SO
        // is turned on.)
        const isCheckGoDoc = String(claimed.docType) === 'CHECK_AND_GO';
        const directionAllowed = isCheckGoDoc ? config.mergeCheckGoIntoSpk : config.mergeIntoCheckGo;
        // "A booked appointment is its own visit" means ANOTHER DAY, not the
        // routine half-hour of plan time every document carries: /api/checkgo
        // stamps scheduledAt = now + 30 min on EVERY Check & Go, and the `sched`
        // test above fires at 5 minutes. Excluding on `sched` alone would have
        // meant no Check & Go ever merged — the feature would have shipped and
        // quietly done nothing. The car is at the counter now; a visit booked
        // for a different day is the real exception.
        const bookedAnotherDay = Boolean(sched) && formatDateWib(sched!) !== formatDateWib(new Date().toISOString());
        const mergeEligible = !bookedAnotherDay && payload.serviceLines.length > 0;
        if (directionAllowed && mergeEligible) {
          const decision = await findCheckGoMergeTarget(claimed, config.mergeWindowHours);
          // How long has THIS SPK been waiting? Measured from its own first
          // hold: a Check & Go that keeps failing transiently is requeued every
          // few minutes, and its updatedAt is rewritten each time, so anything
          // measured on the candidate would read "fresh" forever and the SPK
          // would wait for a car that never arrives.
          const heldSince = claimed.push.mergeHoldSince ?? null;
          const heldForMs = heldSince ? Date.now() - Date.parse(heldSince) : 0;
          if (decision.hold && heldForMs >= MERGE_HOLD_MAX_MS) {
            log(
              `· ${doc._id} sudah menunggu Check & Go ${decision.hold.spkId} ${Math.round(heldForMs / 60_000)} menit — tidak ditunggu lagi, SPK dibuat SO sendiri`,
            );
            await collections.spk().updateOne({ _id: doc._id }, { $unset: { 'push.mergeHoldSince': '' } }).catch(() => {});
            decision.hold = null;
          }
          if (decision.hold) {
            // Release the claim (attempt refunded) and ask to be left alone for
            // a few minutes: fetchBatch skips a queued doc whose nextAttemptAt
            // is in the future, so this run's grace loop and the next cron do
            // not re-claim it every 3 s. Racing the Check & Go now is how one
            // car becomes two orders; the next pass finds it confirmed and
            // appends.
            await transition(doc._id, 'pushing', 'queued', {
              push: {
                ...claimed.push,
                attempt: Math.max(0, claimed.push.attempt - 1),
                lease: doc.push.lease,
                nextAttemptAt: new Date(Date.now() + MERGE_HOLD_RECHECK_MS).toISOString(),
                mergeHoldSince: heldSince ?? new Date().toISOString(),
                lastError: `menunggu Check & Go ${decision.hold.spkId} (${decision.hold.state}) selesai — satu mobil satu SRO`,
              },
            }).catch(() => {});
            log(`· ${doc._id} menunggu Check & Go ${decision.hold.spkId} (${decision.hold.state}) selesai dulu — supaya satu mobil satu SRO (dicek lagi ${MERGE_HOLD_RECHECK_MS / 60_000} menit)`);
            continue;
          }
          if (decision.note) log(`  · gabung: ${decision.note}`);
          if (!decision.target && triedMerge) {
            // An earlier attempt got as far as the Check & Go's edit form and
            // did NOT report a clean fallback; the read-back above could not
            // find our token, but "cannot see it" is not "it is not there"
            // (a kicked session reads nothing). The target is gone now — the
            // visit was invoiced, or a newer Check & Go took its place — so
            // there is nothing left to merge into and creating would risk the
            // duplicate this whole path exists to prevent.
            await transition(doc._id, 'pushing', 'manual_intervention', {
              push: {
                ...claimed.push,
                failureClass: 'structural',
                lastError: `Percobaan gabung ke SO Check & Go ${claimed.push.mergeAttempt?.targetSpkId ?? '?'} terputus dan SO itu sudah tidak bisa dipakai — CEK MANUAL di Turboly apakah baris SPK ini sudah masuk. Jangan buat SO baru sebelum yakin.`,
              },
            }).catch(() => {});
            out.failed++;
            log(`⚠ ${doc._id}: gabung terputus dan target hilang — manual_intervention (jangan buat SO baru)`);
            continue;
          }
          if (decision.target) {
            const target: AppendTarget = {
              serviceOrderUrl: decision.target.serviceOrderUrl,
              expectedPlate: (payload.vehiclePlateFull || payload.vehicleRegistration).replace(/\s/g, ''),
              spkToken: claimed.push.correlationToken,
            };
            const ap = await branchSinks.withSink(claimed.branchCode, (sink) =>
              sink.appendLinesToServiceOrder
                ? sink.appendLinesToServiceOrder(target, payload, { workerId, epoch, approve: false, leaseExpiresAt })
                : Promise.resolve({ ok: false as const, serviceOrderNo: null, fallbackToCreate: true, failureClass: 'structural' as const, error: 'sink ini tidak bisa mengedit Service Order yang sudah ada' }),
            );
            if (ap.ok) {
              const at = new Date().toISOString();
              // What a HUMAN still has to do lives on the document, not only in
              // a CI log nobody at the branch reads: the board shows these.
              const warnings = [
                decision.note,
                ap.notesCarried === false
                  ? 'Catatan SPK (keluhan / pekerjaan lain / kondisi) tidak ikut — SO Check & Go sudah APPROVED sehingga kolom catatan tidak ada. Baris jasa & sparepart tetap masuk.'
                  : null,
                ap.approvalReset === true
                  ? 'SO Check & Go tadinya APPROVED; setelah ditambah baris Turboly mengembalikannya ke PENDING APPROVAL — minta approval ulang.'
                  : null,
                ap.inspectionsLost === true
                  ? 'PERIKSA: daftar inspeksi Check & Go di SO berkurang setelah baris SPK ditambahkan. Isi ulang dari kartu Check & Go (checklist lengkap masih tersimpan di sistem kita).'
                  : null,
              ].filter((x): x is string => Boolean(x));
              const merged = {
                ...claimed.turboly,
                serviceOrderNo: ap.serviceOrderNo ?? decision.target.serviceOrderNo,
                // The URL is the Check & Go doc's (unique per doc); this doc points at it via mergedInto.
                serviceOrderUrl: null,
                mergedInto: { spkId: decision.target.spkId, serviceOrderUrl: decision.target.serviceOrderUrl, serviceOrderNo: ap.serviceOrderNo ?? decision.target.serviceOrderNo, at, ...(warnings.length ? { warnings } : {}) },
              };
              await transition(doc._id, 'pushing', 'pushed', { turboly: merged, push: { ...claimed.push, mergeHoldSince: null } });
              await collections.spk().updateOne({ _id: decision.target.spkId }, { $addToSet: { 'checkGo.mergedSpkIds': doc._id } }).catch(() => {});
              out.pushed++;
              log(`✓ ${doc._id} → digabung ke SO ${merged.serviceOrderNo ?? '?'} milik Check & Go ${decision.target.spkId}${ap.alreadyAppended ? ' (sudah ada dari percobaan sebelumnya — diadopsi)' : ''}`);
              for (const w of warnings) log(`  ⚠ ${w}`);
              // Read-back on the Check & Go's order: our token must be visible there.
              const v = await branchSinks
                .withSink(claimed.branchCode, (sink) => sink.verifyByToken({ ...claimed, turboly: { ...merged, serviceOrderUrl: decision.target!.serviceOrderUrl } }))
                .catch(() => null);
              if (v?.found) {
                await transition(doc._id, 'pushed', 'confirmed', {
                  turboly: { ...merged, serviceOrderNo: v.serviceOrderNo ?? merged.serviceOrderNo, readback: { matchedOn: ['reference_token', 'merged_into_checkgo'], lineCount: v.lineCount, lineSkus: v.lineSkus, km: v.km } },
                });
                out.confirmed++;
                log(`  ✓ verified on Check & Go order → confirmed`);
              } else {
                log(`  ⚠ not verified (left in 'pushed')`);
              }
              // A Check & Go that joined the SPK's order still owes that order
              // its inspection list — the whole point of a Cek n Go, and the
              // thing Turboly prints. It goes to the TARGET order, not to one
              // this document never created.
              await fillInspectionsFor(claimed, decision.target.serviceOrderUrl, log);
              continue;
            }
            // Append did not happen cleanly.
            const stamp = { mergeAttempt: { at: new Date().toISOString(), targetSpkId: decision.target.spkId, error: ap.error ?? null, failureClass: ap.failureClass ?? null, fellBack: ap.fallbackToCreate === true } };
            if (!ap.fallbackToCreate) {
              const transient = ap.failureClass === 'transient' || ap.failureClass === 'auth' || ap.failureClass === 'infra';
              if (transient) {
                await transition(doc._id, 'pushing', 'failed', {
                  push: { ...claimed.push, ...stamp, attempt: Math.max(0, claimed.push.attempt - 1), failureClass: ap.failureClass ?? 'transient', lastError: ap.error ?? 'gabung gagal (sementara)', nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString() },
                }).catch(() => {});
                out.failed++;
                log(`✗ ${doc._id}: gabung ke SO Check & Go gagal sementara — ${ap.error ?? ''}`);
                continue;
              }
              // Save was clicked and the outcome is unknown: a human looks, and
              // NOTHING may create a second order for this SPK meanwhile.
              await transition(doc._id, 'pushing', 'manual_intervention', {
                push: { ...claimed.push, ...stamp, failureClass: 'structural', lastError: ap.error ?? 'gabung ke SO Check & Go tidak terkonfirmasi — CEK MANUAL' },
              }).catch(() => {});
              out.failed++;
              log(`⚠ ${doc._id}: ${ap.error ?? 'gabung tidak terkonfirmasi'} — dipindah ke manual_intervention (jangan buat SO baru)`);
              continue;
            }
            // Nothing irreversible happened on the Check & Go's order: create a
            // separate one, exactly as before this feature — loudly, and stamped.
            // Carried in `claimed` too: the create-failure handler below writes
            // `push` as a whole object built from this snapshot, so a stamp that
            // lived only in Mongo would be erased on exactly the document a
            // human has to debug.
            claimed.push = { ...claimed.push, ...stamp };
            await collections.spk().updateOne({ _id: doc._id }, { $set: { 'push.mergeAttempt': stamp.mergeAttempt } }).catch(() => {});
            log(`  ⚠ gabung ke SO Check & Go ${decision.target.spkId} tidak bisa (${ap.error ?? '?'}) — dibuat SO terpisah seperti biasa`);
          }
        }

        const res = await branchSinks.withSink(claimed.branchCode, (sink) =>
          sink.pushServiceOrder(payload, { workerId, epoch, approve: config.approveAfterSave, leaseExpiresAt }),
        );
        if (!res.ok) {
          out.failed++;
          // A transient failure is the TENANT's outage (deploy window, 429
          // throttle), not this document's fault: refund the attempt so a
          // one-hour vendor incident can never walk an order to MAX_ATTEMPTS
          // and strand it, and back off 10 min instead of hammering the
          // rate limiter every cron tick.
          const transient = (res.failureClass ?? 'structural') === 'transient';
          await transition(doc._id, 'pushing', 'failed', {
            push: {
              ...claimed.push,
              ...(transient ? { attempt: Math.max(0, claimed.push.attempt - 1) } : {}),
              failureClass: res.failureClass ?? 'structural',
              lastError: res.error ?? 'push failed',
              nextAttemptAt: new Date(Date.now() + (transient ? 10 * 60_000 : 60_000)).toISOString(),
            },
          }).catch(() => {});
          log(`✗ ${doc._id}: [${res.failureClass ?? '?'}] ${res.error ?? ''}`);
          continue;
        }
        const pushedTurboly = { ...claimed.turboly, serviceOrderNo: res.serviceOrderNo, serviceOrderUrl: res.serviceOrderUrl ?? null };
        try {
          await transition(doc._id, 'pushing', 'pushed', { turboly: pushedTurboly });
        } catch (e) {
          // Storage refused the read-back keys (the order's identity is already
          // claimed by another doc). The Service Order EXISTS — parking this in
          // manual_intervention is the only safe answer, because a `failed` doc
          // gets retried and the retry would create a SECOND order in Turboly.
          await transition(doc._id, 'pushing', 'manual_intervention', {
            push: {
              ...claimed.push,
              failureClass: 'structural',
              lastError: `SO ${res.serviceOrderNo} (${res.serviceOrderUrl ?? '-'}) sudah diklaim dokumen lain di Mongo — JANGAN retry, order sudah ada di Turboly: ${(e as Error).message ?? e}`,
            },
          }).catch(() => {});
          out.failed++;
          log(`⚠ ${doc._id}: SO ${res.serviceOrderNo} sudah diklaim dokumen lain — dipindah ke manual_intervention (order sudah ada, jangan retry)`);
          continue;
        }
        out.pushed++;
        log(`✓ ${doc._id} → Service Order ${res.serviceOrderNo}${res.approved === false ? ' ⚠ MASIH DRAFT (approve tidak terkonfirmasi)' : res.approved ? ' [APPROVED]' : ''}`);

        const v = await branchSinks.withSink(claimed.branchCode, (sink) =>
          sink.verifyByToken({ ...claimed, turboly: pushedTurboly }),
        );
        if (v.found) {
          await transition(doc._id, 'pushed', 'confirmed', {
            turboly: { ...pushedTurboly, serviceOrderNo: v.serviceOrderNo, readback: { matchedOn: ['reference_token'], lineCount: v.lineCount, lineSkus: v.lineSkus, km: v.km } },
          });
          out.confirmed++;
          log(`  ✓ verified → confirmed`);
        } else {
          log(`  ⚠ not verified (left in 'pushed')`);
        }

        // Check & Go findings → the SO's Inspection List (Turboly's own answer
        // to "where do the selections go": the Inspection List becomes the
        // SRO's notes and feeds /reports/inspection_lists).
        //
        // LAST, and deliberately after the read-back. This is a raw-HTTP call
        // that LOGS IN AGAIN, and Turboly allows one session per user — so it
        // can kick the Playwright session out from under whatever runs next.
        // Everything that decides the document's state has already happened by
        // here, which is what makes the failure it can cause survivable: the
        // order exists, it is confirmed, and a missing Inspection List is a
        // gap in the ERP's notes rather than a lost Service Order.
        await fillInspectionsFor(claimed, res.serviceOrderUrl ?? null, log);
      } catch (e) {
        out.failed++;
        await transition(doc._id, 'pushing', 'failed', {
          push: { ...claimed.push, failureClass: 'structural', lastError: String((e as Error).message ?? e), nextAttemptAt: new Date(Date.now() + 60_000).toISOString() },
        }).catch(() => {});
        log(`✗ ${doc._id}: ${(e as Error).message ?? e}`);
      }
    }

    if (budgetHit || opts.onlyId) break;
    // An SPK assigned WHILE this batch was pushing used to wait for the next
    // */5 cron plus another 60-90s runner cold start, because the candidate
    // list was read once and never again. This runner is already alive and
    // already logged in, so re-ask before letting it die. Terminates on the
    // `seen` filter above (and the budget).
    if (Date.now() >= deadline) break;
    docs = await fetchBatch();
  }

  return out;
}
