/**
 * Run the branch-add workflow from the app, so opening a branch does not
 * require a GitHub account.
 *
 * The counter staff already sign in to this app with the shared staff
 * password; GitHub has no equivalent, and handing out repo Write access to run
 * one workflow also hands out the pusher and the code. So the app dispatches
 * it on their behalf and GitHub only ever sees the one machine token.
 *
 * Env (set in Vercel), same token used by triggerTurbolyPush:
 *   GH_DISPATCH_TOKEN  fine-grained PAT for the repo. This call needs
 *                      "Actions: Read and write" — repository_dispatch only
 *                      needs Contents, so a token cut for the pusher alone
 *                      answers 403 here. That is reported, not swallowed:
 *                      unlike a push (which a cron will retry), nothing else
 *                      opens a branch, so a silent no-op would look like it
 *                      worked and the branch would simply never appear.
 *   GH_REPO            optional "owner/name" (defaults to VictorP2027/nawilis-spk)
 */

export type BranchAddInputs = {
  code: string;
  name: string;
  store: string;
  type: string;
  abbrev: string;
  no_turboly: boolean;
};

export type DispatchResult =
  | { ok: true }
  | { ok: false; status: number; error: string; hint?: string };

export async function triggerBranchAdd(inputs: BranchAddInputs): Promise<DispatchResult> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    return { ok: false, status: 503, error: 'GH_DISPATCH_TOKEN belum diatur di server.', hint: 'Set di Vercel → Settings → Environment Variables.' };
  }
  const repo = process.env.GH_REPO ?? 'VictorP2027/nawilis-spk';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/branch-add.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      // GitHub requires every workflow_dispatch input to be a STRING, booleans
      // included — a real `false` is rejected with a 422 that names no field.
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          code: inputs.code,
          name: inputs.name,
          store: inputs.store,
          type: inputs.type,
          abbrev: inputs.abbrev,
          no_turboly: inputs.no_turboly ? 'true' : 'false',
        },
      }),
      signal: ctrl.signal,
    });
    if (res.status === 204) return { ok: true };
    const body = await res.text().catch(() => '');
    // 403 and 404 are different problems and used to read as the same one.
    // A token without Actions permission answers 403; a token that cannot see
    // the repo at all — or a workflow file missing from the default branch —
    // answers 404, and telling that person to widen permissions sends them to
    // fix the wrong thing.
    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        error: 'Token GitHub tidak punya izin menjalankan workflow.',
        hint: 'Beri izin "Actions: Read and write" pada GH_DISPATCH_TOKEN (GitHub → Settings → Developer settings → Fine-grained tokens).',
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        error: `Workflow branch-add tidak ditemukan di ${repo} (cabang main).`,
        hint: 'Bisa berarti token tidak bisa melihat repo ini, atau branch-add.yml belum ada di main.',
      };
    }
    if (res.status === 422) {
      return {
        ok: false,
        status: 422,
        error: 'GitHub menolak isian ini.',
        hint: 'Biasanya karena ada kolom yang tidak dikenal atau cabang main tidak punya workflow ini.',
      };
    }
    return { ok: false, status: res.status, error: `GitHub menolak (HTTP ${res.status}).`, hint: body.slice(0, 200) || undefined };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'GitHub tidak menjawab dalam 8 detik.' : ((e as Error).message ?? String(e));
    return { ok: false, status: 504, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
