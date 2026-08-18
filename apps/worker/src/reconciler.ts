import { collections, newSpkId, parseCorrelationToken } from '@spk/core';
import type { BranchSinks } from './sessions.js';
import { fireAlert } from './alerts.js';

/**
 * Nightly reconciliation. Designed to read ZERO on a normal day — the only way
 * a control gets read every morning is if a non-zero result actually means
 * something. Identity-based (correlation token), NO date-bucket join (three
 * different dates are in play; any date join produces false deltas daily).
 *
 *   missingInTurboly  — Mongo says confirmed, token absent in Turboly  → silent loss
 *   extraWithOurToken — same token on >1 Turboly SO                    → DOUBLE-PUSH (page!)
 *   extraNoToken      — Turboly SO with no token                       → manual entry (info)
 *   stuck             — non-terminal SPKs older than 4h                → pipeline stall
 *
 * `harvestTokens` must be provided by the caller — via the API sink (cheap) or
 * by scraping the Service Order list over a 72h rolling window (RPA).
 */
export interface HarvestedSo {
  serviceOrderNo: string;
  referenceText: string | null;
}

export async function reconcile(harvest: () => Promise<HarvestedSo[]>): Promise<void> {
  const ranAt = new Date().toISOString();

  const harvested = await harvest();
  const turbolyTokens = new Map<string, string[]>(); // token -> [docNo...]
  let extraNoToken = 0;
  for (const so of harvested) {
    const token = parseCorrelationToken(so.referenceText);
    if (!token) {
      extraNoToken++;
      continue;
    }
    const key = `SPK:${token}`;
    const arr = turbolyTokens.get(key) ?? [];
    arr.push(so.serviceOrderNo);
    turbolyTokens.set(key, arr);
  }

  // Our side: everything we believe reached Turboly.
  // A MERGED SPK's token is not in any Service Order's Reference Number: its
  // lines (and the token with them) sit inside the car's Check & Go order,
  // which carries the Check & Go's own reference. Counting those as "missing"
  // would make this control read non-zero every single day, and a control that
  // always reads non-zero is a control nobody reads. They are listed on their
  // own instead, so the merge stays visible without drowning the real signal.
  const confirmed = await collections
    .spk()
    .find({ state: { $in: ['pushed', 'confirmed', 'amend_pending'] } }, { projection: { _id: 1, 'push.correlationToken': 1, 'turboly.mergedInto': 1 } })
    .toArray();
  const mergedTokens = new Set(confirmed.filter((d) => d.turboly?.mergedInto).map((d) => d.push.correlationToken));
  const ourTokens = new Set(confirmed.filter((d) => !d.turboly?.mergedInto).map((d) => d.push.correlationToken));

  const missingInTurboly = [...ourTokens].filter((t) => !turbolyTokens.has(t));
  const extraWithOurToken: string[] = [];
  for (const [token, docNos] of turbolyTokens) {
    if (docNos.length > 1) extraWithOurToken.push(`${token}=>${docNos.join(',')}`); // double-push
  }

  // "Stuck" excludes awaiting_assignment — parked-waiting-for-a-mechanic is a
  // normal business state, not a pipeline stall.
  const stuck = await collections.spk().countDocuments({
    state: { $nin: ['confirmed', 'voided', 'superseded', 'awaiting_assignment'] },
    'capture.capturedAt': { $lt: new Date(Date.now() - 4 * 3600_000).toISOString() },
  });

  const alertsFired: string[] = [];
  if (extraWithOurToken.length > 0) {
    alertsFired.push('DOUBLE_PUSH');
    await fireAlert({ level: 'page', code: 'RECON_DOUBLE_PUSH', message: `${extraWithOurToken.length} tokens on >1 Turboly SO`, data: { extraWithOurToken } });
  }
  if (missingInTurboly.length > 0) {
    alertsFired.push('MISSING');
    await fireAlert({ level: 'ops', code: 'RECON_MISSING', message: `${missingInTurboly.length} confirmed-in-Mongo missing in Turboly`, data: { sample: missingInTurboly.slice(0, 20) } });
  }
  if (stuck > 0) {
    alertsFired.push('STUCK');
    await fireAlert({ level: 'ops', code: 'RECON_STUCK', message: `${stuck} SPKs stuck >4h in a non-terminal state` });
  }

  await collections.reconRuns().insertOne({
    _id: newSpkId(),
    ranAt,
    windowHours: 72,
    missingInTurboly,
    extraWithOurToken,
    extraNoToken,
    stuck,
    mergedIntoCheckGo: mergedTokens.size,
    alertsFired,
  });

  console.log(`[recon] ${ranAt} missing=${missingInTurboly.length} double=${extraWithOurToken.length} noToken=${extraNoToken} stuck=${stuck} merged=${mergedTokens.size}`);
}
