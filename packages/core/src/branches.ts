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
 * The 27 built-ins answer with no I/O, which is every SPK today; only a branch
 * added since the deploy costs one indexed _id lookup.
 */
export async function branchTypeFor(code: string): Promise<RefBranch['type']> {
  const builtIn = REF_BRANCHES.find((b) => b.code === code);
  if (builtIn) return builtIn.type;
  const row = await collections.branches().findOne({ _id: code }).catch(() => null);
  return row?.type ?? 'NAWILIS';
}
