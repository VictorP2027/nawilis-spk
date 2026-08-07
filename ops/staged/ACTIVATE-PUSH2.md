# Activating the second Turboly push worker

Everything here is STAGED: `ops/staged/push2.yml` is inert where it sits
(GitHub only runs workflows from `.github/workflows/`), the kick-test script
changes nothing, and no application code is touched at any step. Activation is
one `git mv`; rollback is deleting one file.

## Why this exists

One Turboly account = one session, so today every push, flow action and catalog
sync serialises through a single lane (`concurrency: turboly-push`), and a
morning rush of 100 orders waits ~40 min worst-case (~84 SO/hr measured). A
second worker on its OWN Turboly account halves that — **if** Turboly scopes
sessions per user, which is exactly what the kick test proves or disproves.

## Preconditions, in order — do not skip ahead

### 0. Vendor answer
Ask (Fahrian is responsive): can the tenant have another user account, and does
it cost per seat? Needed: same permissions as the pusher account, access to all
stores, **no 2FA**.

### 1. Create the account (Turboly → Setup → Users & Permissions)
e.g. `pusher2@…`. Log in once by hand to clear any first-login prompt
(password-change / EULA), which would wedge the RPA.

### 2. Kick test — the go/no-go gate
Pause the crons around it (a login as account 1 kicks a live cron session), and
re-enable in the SAME command so an interrupted run still restores them:

    for w in push.yml flow.yml sync.yml; do gh workflow disable $w; done; \
    TURBOLY_USERNAME_2='pusher2@…' TURBOLY_PASSWORD_2='…' \
      node --env-file=.env scripts/kick-test.mjs --hold=120; \
    for w in push.yml flow.yml sync.yml; do gh workflow enable $w; done

- `✅ PASS` → continue.
- `❌ FAIL` → sessions are tenant-scoped; parallelism is impossible. Stop here,
  delete this directory, nothing was harmed.

### 3. Secrets

    gh secret set TURBOLY_USERNAME_2 --body 'pusher2@…'
    gh secret set TURBOLY_PASSWORD_2 --body '…'

### 4. Activate

    git mv ops/staged/push2.yml .github/workflows/push2.yml
    git commit -m 'ops: activate second Turboly push worker'
    git push origin main

The file differs from `push.yml` in exactly four places: workflow name,
concurrency lane `turboly-push-2`, `*_2` secrets, cron offset by 2 min. The
claim layer (CAS queued→pushing + unique claim + lease + orphan reclaim) already
arbitrates two workers racing one document — no code change is needed or made.

### 5. Same-branch contention check (first day)
SO numbers are per-branch sequences. Watch the first occasions both workers
save into ONE branch near-simultaneously; if Turboly ever errors on number
allocation, it will surface as a transient failure and retry — but confirm.

### 6. Ops follow-through
- `scripts/monitor.mjs`: add `push2.yml` to the watched-workflows list (the one
  optional one-line code edit in this whole plan — until then the disabled-
  workflow alert does not cover worker 2).
- The pause-for-local-RPA practice now includes `push2.yml`:
  `for w in push.yml push2.yml flow.yml sync.yml; do …`
- Prod go-live checklist: create the same account on production Turboly.

## Rollback

    git rm .github/workflows/push2.yml && git commit && git push
    # or instantly, without a commit:
    gh workflow disable push2.yml
