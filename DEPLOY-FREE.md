# Deploy for FREE (Vercel + Atlas + Google Cloud Free VM)

Runs the whole system in the cloud at **$0/month**, always-on (works with your laptop off):

| Piece | Free host | Cost |
|---|---|---|
| Web app (form + admin) | **Vercel** Hobby | $0 |
| Database | **MongoDB Atlas** M0 | $0 (already set up) |
| Push worker (Playwright RPA) | **Google Cloud Free VM** (e2-micro, always-on) | $0 |
| Code | **GitHub** | $0 |

> The Google Cloud **e2-micro "Always Free"** VM is genuinely $0 forever (no time limit)
> in regions `us-west1`, `us-central1`, or `us-east1`. A card is required at signup for
> identity only — Always Free resources are not billed. Set a $1 budget alert for comfort.

The worker is a single Node process (**Redis-free push loop**) kept alive by pm2 —
it polls Atlas for `queued` SPKs and pushes+verifies each into Turboly. This is the
exact path proven live (created `SRO/BKS/26080002`, `26080003`).

Prereq: push this repo to **GitHub** (private is fine) — both Vercel and the VM pull from it.

---

## Worker — Option B (ACTIVE): GitHub Actions (no credit card)

The no-card path, and what's currently running. A scheduled Actions workflow runs the
pusher in GitHub's cloud — no server, no card. Proven live: created & verified
`SRO/BKS/26080004` from a CI run.

**Already set up in this repo:**
- `.github/workflows/push.yml` — cron `*/5 * * * *` + a manual **Run workflow** button.
  Each run executes `push-once`: finds every `queued` SPK, creates+verifies its Turboly
  Service Order, then exits. Empty passes never log into Turboly.
- Encrypted Actions **secrets**: `MONGODB_URI`, `TURBOLY_USERNAME`, `TURBOLY_PASSWORD`.

**Public vs private:** public repos get **unlimited** free Actions minutes (→ ~5-min cadence);
private repos are capped at ~2,000 min/mo (→ run every ~30 min to stay free). Make it public:
```bash
gh repo edit VictorP2027/nawilis-spk --visibility public --accept-visibility-change-consequences
```
> Public = the code/method is world-readable (secrets stay in the encrypted store, NOT the code).
> Trade-off accepted for this deploy.

**Manage it:**
```bash
gh workflow run push.yml --repo VictorP2027/nawilis-spk   # trigger now
gh run watch --repo VictorP2027/nawilis-spk               # watch latest
gh run list  --repo VictorP2027/nawilis-spk               # history
# rotate/replace a secret:
gh secret set TURBOLY_PASSWORD --repo VictorP2027/nawilis-spk
```

### Make it INSTANT (fire on assignment, not on the clock)

The workflow also listens for `repository_dispatch (spk-assigned)`, and the web app fires that
event the moment an SPK is released to the queue (`apps/web/app/api/spk/[id]/assign/route.ts` →
`lib/triggerPush.ts`). So a push starts within **seconds** of assignment instead of waiting for
the 5-min cron. To turn it on:

1. **Create a token:** GitHub → Settings → Developer settings → **Fine-grained tokens** →
   Generate. Repository access = only `nawilis-spk`; Permissions → **Contents: Read and write**
   (that's what `repository_dispatch` needs). Copy the token.
2. **Add it to Vercel:** your project → Settings → Environment Variables →
   `GH_DISPATCH_TOKEN = <token>` (and optionally `GH_REPO = VictorP2027/nawilis-spk`). Redeploy.

That's it — assign an SPK and the Turboly push kicks off immediately. The 5-min cron stays as a
safety net, and if the token isn't set the app just skips the kick (cron still covers it).

> **Reality check:** even instant-triggered, each run cold-starts a fresh GitHub runner
> (~1–2 min to install + build) before it pushes — so "instant" here means ~1–2 min end-to-end,
> not seconds-to-Turboly. GitHub can't hold a warm process. For **sub-15-second** pushing you need
> a machine that's already running: Option A (free VM, needs a card) or your own always-on device.

**Caveats:** GitHub delays scheduled runs a few min under load; scheduled workflows auto-pause after
60 days of repo inactivity (any commit re-arms them); public = code/method world-readable (secrets
stay encrypted).

---

## 1. Web app → Vercel (5 min)

1. https://vercel.com → **Add New Project** → import your GitHub repo.
2. **Root Directory:** `apps/web`
3. **Build Command:** `cd ../.. && npm run build -w @spk/core && cd apps/web && next build`
4. **Install Command:** `npm install` (run at repo root — installs the workspaces)
5. **Environment Variables:**
   ```
   MONGODB_URI = mongodb+srv://...        (your Atlas string)
   MONGODB_DB  = spk
   AUTH_SECRET = <any 32-byte base64>
   ```
   (For the Supabase clone instead, deploy `apps/web-supabase` the same way with
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.)
6. Deploy. Your form is now at `https://<project>.vercel.app/sheet`.

> `next.config.mjs` tries to load a root `.env` but is wrapped in try/catch, so on
> Vercel (no `.env` file) it just uses the dashboard env vars. No change needed.

---

## 2. Push worker → Google Cloud Free VM (~15 min, one time)

### 2a. Create the free VM (browser only)
1. https://console.cloud.google.com → sign in with your Google account.
2. Create a **project** (top bar → New Project → name it `nawilis-spk`).
3. **Billing** → link a billing account (add a card). Always-Free e2-micro is **not billed**;
   the card is identity-only. (Optional peace of mind: **Billing → Budgets → Create budget → $1**.)
4. **Compute Engine → VM instances → Enable API** (first time, ~1 min).
5. **Create instance:**
   - **Name:** `spk-worker`
   - **Region:** `us-west1` (or `us-central1` / `us-east1` — these three ONLY are free-tier)
   - **Machine type:** series **E2**, **e2-micro** ← the exact free one
   - **Boot disk:** Change → **Ubuntu 22.04 LTS**, **30 GB Standard** (not SSD — 30 GB standard is the free limit)
   - Leave firewall unchecked (worker only makes OUTbound calls; no inbound needed).
   - **Create.**
6. When it shows a green check, click **SSH** in its row → a terminal opens **in your browser**
   (no keys, no local terminal needed).

### 2b. Install + build (paste into the browser SSH)
Clone the private repo (log into GitHub first), then run the one-shot setup:
```bash
sudo apt-get update -y && sudo apt-get install -y git gh
gh auth login          # GitHub.com → HTTPS → Login with a web browser → paste the code
git clone https://github.com/VictorP2027/nawilis-spk.git ~/nawilis-spk
cd ~/nawilis-spk && bash scripts/vm-setup.sh
```
`vm-setup.sh` adds 2 GB swap (vital on 1 GB RAM), installs Node 22, Playwright + Chromium,
builds core + worker, and installs pm2. Takes ~5–8 min on e2-micro.

### 2c. Configure `.env` on the VM
```bash
cd ~/nawilis-spk && nano .env
```
Paste and fill in:
```
MONGODB_URI=mongodb+srv://...           # your Atlas connection string
MONGODB_DB=spk
TURBOLY_BASE_URL=https://sandbox.turboly.com   # sandbox until fully verified!
PUSH_MODE=rpa
PUSH_APPROVE=true
CREDENTIAL_ENC_KEY=<32-byte base64>     # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TURBOLY_USERNAME=<service account>      # must NOT have 2FA (headless VM can't solve OTP)
TURBOLY_PASSWORD=<password>
PUSH_WINDOW_START=00:00                 # run 24/7 (or set 07:00–20:00 for business hours WIB)
PUSH_WINDOW_END=23:59
```
Save with **Ctrl-O, Enter, Ctrl-X**.

### 2d. Database access
Atlas is already open to `0.0.0.0/0` (added earlier for Vercel), so the VM can reach it with
no extra step. To tighten it later: **Atlas → Network Access →** add just the VM's external IP
(shown next to the instance in the console).

### 2e. Start it 24/7
```bash
cd ~/nawilis-spk
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # copy-paste the `sudo ...` line it prints (makes it boot-persistent)
pm2 logs spk-worker         # watch it: polls Atlas, pushes queued SPKs, verifies
```

The worker now polls Atlas every ~15s. Any SPK assigned to a mechanic (state `queued`)
auto-pushes to Turboly and is read-back-verified → `confirmed`. It keeps running with your
laptop off, and restarts itself on crash or VM reboot.

### 2f. Updating later (after code changes)
```bash
cd ~/nawilis-spk && git pull && npm install && npm run build -w @spk/core && npm --workspace @spk/worker run build && pm2 restart spk-worker
```

---

## 3. Turboly master data (before real pushes)
Import your Stores / Service Products / Mechanics so pushes use real SKUs:
```bash
npm run seed:turboly -- ./turboly-export.json    # on the VM or locally against Atlas
```

## Notes
- **Sandbox first.** Keep `TURBOLY_BASE_URL=https://sandbox.turboly.com` until a full
  run is verified, then switch to production.
- **2FA:** the headless VM can't solve OTP — use a Turboly service account without 2FA,
  or do an interactive `login:turboly` once on your laptop and copy the saved
  `.turboly-state/` up (`gcloud`/browser-SSH file upload) for session reuse.
- **Memory:** e2-micro has 1 GB RAM; the setup script adds 2 GB swap so headless Chromium
  runs comfortably for serial (one-at-a-time) pushes — which is exactly how the RPA works.
- **Free limits:** Google Cloud e2-micro is Always Free **forever** (no 12-month clock) in
  us-west1 / us-central1 / us-east1. Atlas M0 = 512 MB (plenty for years of SPKs).
  Vercel Hobby = fine for internal use. 1 GB/mo egress is far more than this worker uses.

---

## Standby site, in case Vercel pauses (added 2026-08-07)

Vercel's free tier pauses a project that exceeds its allowance, and pausing takes
the intake forms down at every branch. Everything else survives — Atlas, the
GitHub Actions pusher, the flow worker, the WhatsApp drainer — because none of
them route through Vercel. What is lost is the thing staff actually touch.

**The app is stateless**, so a second deployment pointed at the same
`MONGODB_URI` is a working copy of the site rather than a separate system. Both
can serve at once; Mongo arbitrates and the pusher does not care which one
captured a document.

### Netlify (recommended — no credit card, 100 GB/month)

`netlify.toml` in the repo root is ready; setup is three steps and is written at
the top of that file. Two properties make it the better standby:

- It builds on a **GitHub push**, so the copy follows `main` by itself instead of
  waiting for someone to remember `vercel --prod` mid-outage. The corollary is
  that it only ever has what has been PUSHED.
- Route handlers run as Node functions, which the `mongodb` driver requires — it
  opens TCP sockets and cannot run on an edge runtime.

Copy only the web app's variables: `MONGODB_URI`, `MONGODB_DB`,
`SPK_SESSION_SECRET`, `STAFF_PASSWORD`, `GH_DISPATCH_TOKEN`, `GH_REPO`,
`NEXT_PUBLIC_TURBOLY_BASE_URL`. The `TURBOLY_*` and `PUSH_*` variables belong to
the worker and must NOT be duplicated here.

### What a switch actually costs

The fallback has a different hostname, so branches follow a different link and
any installed PWA/service-worker cache starts empty on it. A custom domain
pointed at whichever host is live removes that friction entirely — it is the one
piece that needs buying.

### Emergency-only alternative

`next start` on the shop Mac behind a free Cloudflare Tunnel gives a stable
https URL with no account limits at all. It is already the machine running WAHA,
so it is on anyway — but it makes the branches depend on one desk, which is the
dependency this architecture spent its whole life removing. Use it to survive a
day, not as the plan.
