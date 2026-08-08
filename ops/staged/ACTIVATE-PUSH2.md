# Second Turboly push worker — implemented, dormant, and how to wake it

The worker is fully implemented at `.github/workflows/push2.yml` and ships
DORMANT: its first job checks whether `TURBOLY_USERNAME_2` exists as a secret
and, until it does, every run ends there in a few seconds — green, having
touched nothing (the same inert-until-configured pattern `alerts.yml` has used
all along). **Setting the two secrets IS the activation.** No file moves, no
code changes, ever — the claim layer (CAS queued→pushing + unique claim + lease
+ orphan reclaim) already arbitrates two workers racing one document.

While dormant you will see short skipped runs of `push-to-turboly-w2` in the
Actions list (cron + every instant dispatch, ~5s each, like the WhatsApp
sender's). That is the worker proving it is wired, not a fault.

## Waking it — in this order, do not skip ahead

### 0. Vendor answer
Ask (Fahrian is responsive): can the tenant have another user account, and does
it cost per seat? Needed: same permissions as the pusher account, access to all
stores, **no 2FA**.

### 1. Create the account (Turboly → Setup → Users & Permissions)
e.g. `pusher2@…`. Log in once by hand to clear any first-login prompt
(password-change / EULA), which would wedge the RPA.

### 2. Kick test — the go/no-go gate
Proves Turboly scopes one-session-per-user to the USER, not the tenant — the
one assumption parallel workers rest on. Pause the crons around it (a login as
account 1 kicks a live cron session), re-enabling in the SAME command:

    for w in push.yml flow.yml sync.yml; do gh workflow disable $w; done; \
    TURBOLY_USERNAME_2='pusher2@…' TURBOLY_PASSWORD_2='…' \
      node --env-file=.env scripts/kick-test.mjs --hold=120; \
    for w in push.yml flow.yml sync.yml; do gh workflow enable $w; done

- `✅ PASS` → continue.
- `❌ FAIL` where **A died but B survived** → almost certainly NOT tenant
  scoping: the Vercel app's prefill lookup logs in as account 1 whenever no
  worker has touched Turboly recently, and that login kicks the test's A
  session. The test prints this diagnosis itself. Re-run during quiet hours
  (or after a fresh SPK submission, which mutes lookups for ~20 min) before
  believing a FAIL.
- `❌ FAIL` otherwise → sessions are tenant-scoped; parallelism is impossible. Delete
  `.github/workflows/push2.yml`, nothing was harmed.

### 3. Close the shared-cookie identity hole (one small code change, reviewed)
Found by adversarial review before shipping: the shared HTTP cookie doc
(`turboly_http_session`, `_id: 'cookie'`) is written by FIVE call sites that
record the cookie but NOT which user it belongs to, while the session adopter
(`packages/core/src/turboly/session.ts:509`) trusts the stored `username`
field. Today that is harmless — every writer IS user 1. With two accounts, an
idle-moment user-1 login can overwrite the cookie under worker 2's label, and
worker 2's next cold run drives Turboly AS USER 1 — two robots on one session,
the exact cross-talk session.ts warns about.

Before setting the secrets, make every writer record its username:
- apps/web/lib/turbolyLookup.ts:104-108
- apps/worker/src/http-once.ts:190-194  (the one flow.yml actually runs)
- packages/core/src/turboly/httpRegister.ts:457-463
- packages/core/src/turboly/httpVehicle.ts ~333
- packages/core/src/turboly/httpServiceOrder.ts ~336

(Deliberately NOT changed while the worker is dormant: truthful usernames would
also make cookie adoption start succeeding where it silently fails today — a
behaviour change, however beneficial, and dormancy's whole point is none.)

### 4. Activate = set the secrets

    gh secret set TURBOLY_USERNAME_2 --body 'pusher2@…'
    gh secret set TURBOLY_PASSWORD_2 --body '…'

From the next run, worker 2 is live. Nothing else to do.

### 5. First-day watch
- **Same-branch contention**: SO numbers are per-branch sequences; watch the
  first near-simultaneous saves into one branch. A clash surfaces as a
  transient failure and retries — confirm it does.
- **Throughput**: expect ~2× (≈170 SO/hr) on a backlog; re-run
  `scripts/load-test.mjs` if you want the number on record.

### 6. Ops follow-through (after activation)
- `scripts/monitor.mjs`: add `'push2.yml'` to the watched list at line ~52
  (`for (const wf of ['push.yml', 'flow.yml'])`). Deliberately NOT added while
  dormant — pre-activation, a disabled dormant worker is not an incident, and
  the monitor cannot tell the difference.
- The pause-for-local-RPA practice becomes:
  `for w in push.yml push2.yml flow.yml sync.yml; do …`
- Prod go-live checklist: create the same account on production Turboly.

## Rollback (any time after activation)

    gh workflow disable push2.yml        # instant stop
    # or return it to dormancy:
    gh secret delete TURBOLY_USERNAME_2 && gh secret delete TURBOLY_PASSWORD_2
    # or remove it entirely:
    git rm .github/workflows/push2.yml && git commit && git push
