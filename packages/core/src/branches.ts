import type { RefBranch } from './refdata.js';
import { REF_BRANCHES } from './refdata.js';
import { collections } from './mongo.js';

/**
 * The branch list, compiled-in plus anything added since.
 *
 * REF_BRANCHES is baked into the bundle on purpose: the intake forms have to
 * open and work at a counter with no network, and a branch picker that waits
 * on a fetch is a form that cannot be filled during an outage. But a branch
 * that opens on a Tuesday cannot wait for a deploy either — so extras live in
 * Mongo and are merged on top here.
 *
 * A row may also RENAME a compiled-in branch (same code, new name), which is
 * how a rebranded outlet gets fixed without a release. It can never change a
 * branch's code: the code is what every SPK ever pushed is filed under.
 */
export async function loadBranchList(): Promise<RefBranch[]> {
  const extra = await collections.branches().find({}).toArray().catch(() => []);
  const merged = new Map<string, RefBranch>(REF_BRANCHES.map((b) => [b.code, b]));
  for (const r of extra) {
    merged.set(r._id, {
      code: r._id,
      name: r.name,
      type: r.type,
      docAbbrev: r.docAbbrev,
      turbolyStoreNameGuess: r.turbolyStoreNameGuess,
    });
  }
  // Compiled-in order first (the counters know it by heart), extras appended
  // in the order they were added.
  const out = REF_BRANCHES.map((b) => merged.get(b.code)!);
  for (const r of extra) if (!REF_BRANCHES.some((b) => b.code === r._id)) out.push(merged.get(r._id)!);
  return out;
}

/**
 * A branch's type, for a branch that may have been opened since the deploy.
 *
 * buildSpkDoc() reads REF_BRANCHES, which is compiled in — so a branch added
 * through /admin/cabang was invisible to it and fell back to NAWILIS. For a
 * new QUICKSERV counter that is silently wrong, and it costs that counter its
 * queue priority (repo.ts gives QUICKSERV 95 and everything else 50).
 *
 * Costs one indexed _id lookup, once per document — not per line; callers that
 * label many documents use branchMap() instead.
 */
export async function branchTypeFor(code: string): Promise<RefBranch['type']> {
  return (await branchRefFor(code))?.type ?? 'NAWILIS';
}

/**
 * One branch, compiled-in or opened since — the whole record, so a caller can
 * take its display name or its Turboly store name too.
 *
 * Anything that labels a branch from REF_BRANCHES alone prints the raw code
 * for a branch added at runtime. That is merely ugly on an export, but the
 * Check & Go WhatsApp quotes it to the CUSTOMER, who has never heard of
 * "NWL-JKT".
 */
export async function branchRefFor(code: string): Promise<RefBranch | null> {
  // Mongo FIRST, exactly like loadBranchList(): a row for a compiled-in code is
  // the documented way to rename a rebranded outlet without a release (see the
  // contract at the top of this file). Short-circuiting on REF_BRANCHES here
  // would make the two resolvers disagree — the pickers and the export would
  // show the new name while the customer's WhatsApp still used the old one.
  const row = await collections.branches().findOne({ _id: code }).catch(() => null);
  if (!row) return REF_BRANCHES.find((b) => b.code === code) ?? null;
  return {
    code: row._id,
    name: row.name,
    type: row.type,
    docAbbrev: row.docAbbrev,
    turbolyStoreNameGuess: row.turbolyStoreNameGuess,
  };
}

/**
 * The merged list as a lookup, for callers that label MANY documents — one
 * read instead of one per row.
 */
export async function branchMap(): Promise<Map<string, RefBranch>> {
  return new Map((await loadBranchList()).map((b) => [b.code, b]));
}
