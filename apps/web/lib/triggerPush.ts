/**
 * Fire a GitHub `repository_dispatch` so the push-to-turboly Actions workflow
 * runs IMMEDIATELY when an SPK is assigned — instead of waiting for the 5-min
 * cron. This is what makes the GitHub deploy feel instant.
 *
 * Env (set in Vercel):
 *   GH_DISPATCH_TOKEN  fine-grained PAT for the repo, "Contents: Read and write"
 *                      (that scope is what repository_dispatch requires)
 *   GH_REPO            optional "owner/name" (defaults to VictorP2027/nawilis-spk)
 *
 * No token configured → no-op (so local dev never errors). Best-effort and
 * time-boxed: a GitHub hiccup must never fail the assignment itself.
 */
export async function triggerTurbolyPush(spkId: string): Promise<void> {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return; // not configured (e.g. local dev) — the cron still covers it
  const repo = process.env.GH_REPO ?? 'VictorP2027/nawilis-spk';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'spk-assigned', client_payload: { spkId } }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`triggerTurbolyPush: GitHub dispatch failed ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (e) {
    console.error(`triggerTurbolyPush: ${(e as Error).message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}
