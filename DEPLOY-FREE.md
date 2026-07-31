# Deploy for FREE (Vercel + Atlas + Oracle Cloud Free VM)

Runs the whole system in the cloud at **$0/month**:

| Piece | Free host | Cost |
|---|---|---|
| Web app (form + admin) | **Vercel** Hobby | $0 |
| Database | **MongoDB Atlas** M0 | $0 (already set up) |
| Push worker (Playwright RPA) | **Oracle Cloud Free VM** (always-on, static IP) | $0 |
| Redis (worker queue) | **on the same VM** | $0 |
| Code | **GitHub** | $0 |

Prereq: push this repo to **GitHub** (private is fine) — both Vercel and the VM pull from it.

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

## 2. Push worker → Oracle Cloud Free VM (~30 min, one time)

### 2a. Create the VM
1. https://www.oracle.com/cloud/free → sign up (card for identity check; **not charged**
   on Always Free resources).
2. **Compute → Instances → Create.** Image **Ubuntu 22.04**, Shape
   **VM.Standard.A1.Flex** (Ampere ARM — Always Free: up to 4 OCPU / 24 GB; 1 OCPU /
   6 GB is plenty).
3. Under Networking, **assign a public IPv4**. Then **reserve** it (Networking →
   Reserved IPs) so it's **static**.
4. Add your SSH key, create, and `ssh ubuntu@<vm-ip>`.

### 2b. Install + build (one command)
```bash
export REPO_URL=git@github.com:YOU/nawilis-spk.git   # your repo
curl -fsSL https://raw.githubusercontent.com/YOU/nawilis-spk/main/scripts/vm-setup.sh | REPO_URL=$REPO_URL bash
```
(or copy `scripts/vm-setup.sh` up and run it). It installs Node 20, Redis, Playwright +
Chromium, builds core + worker, and installs pm2.

### 2c. Configure `.env` on the VM
```bash
cd ~/nawilis-spk && nano .env
```
```
MONGODB_URI=mongodb+srv://...           # Atlas
MONGODB_DB=spk
REDIS_URL=redis://localhost:6379
TURBOLY_BASE_URL=https://sandbox.turboly.com   # sandbox first!
PUSH_MODE=rpa
PUSH_APPROVE=true
CREDENTIAL_ENC_KEY=<32-byte base64>     # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TURBOLY_USERNAME=<service account>      # must NOT have 2FA (headless VM can't do OTP)
TURBOLY_PASSWORD=<password>
MAX_BROWSER_WORKERS=3
```

### 2d. Allowlist the VM
- **Atlas → Network Access →** add the VM's static IP (so the worker can reach the DB).
- Note the same IP for Turboly (and, later, ask the vendor to allowlist it).

### 2e. Start it 24/7
```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # run the command it prints (survives reboots)
pm2 logs spk-worker
```

The worker now polls Atlas every ~15s, and any SPK you assign to a mechanic
auto-pushes to Turboly and gets verified.

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
  or do an interactive `login:turboly` once and copy the saved `.turboly-state/` up to
  the VM (session reuse).
- **Static IP** is the reason to prefer this over GitHub Actions: Turboly + Atlas see one
  consistent address you can allowlist, and it's defensible automation.
- Free limits: Oracle Always Free ARM is genuinely always-on. Atlas M0 = 512 MB (plenty
  for years of SPKs). Vercel Hobby = fine for internal use.
