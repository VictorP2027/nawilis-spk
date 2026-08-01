#!/usr/bin/env bash
# One-time setup for the Turboly push worker on an Oracle Cloud Free VM
# (Ubuntu 22.04, Ampere ARM / A1.Flex). Run as the default `ubuntu` user.
#
#   REPO_URL=git@github.com:you/nawilis-spk.git bash vm-setup.sh
#
# Redis-free: the worker is a single Node process (push-loop) kept alive by pm2.
set -euo pipefail

echo "▸ swap (2G) — essential on a 1GB e2-micro so headless Chromium isn't OOM-killed"
if ! sudo swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo "  ✓ 2G swap active"
else
  echo "  ✓ swap already present"
fi

echo "▸ system deps + Node 22"
sudo apt-get update -y
sudo apt-get install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "▸ clone repo (set REPO_URL=git@github.com:you/nawilis-spk.git)"
: "${REPO_URL:?set REPO_URL=git@github.com:you/nawilis-spk.git}"
git clone "$REPO_URL" ~/nawilis-spk 2>/dev/null || (cd ~/nawilis-spk && git pull)
cd ~/nawilis-spk

echo "▸ install deps + build core & worker (compiles push-loop.js)"
npm install
npm run build -w @spk/core
npm --workspace @spk/worker run build

echo "▸ Playwright chromium + system libs"
npx playwright install --with-deps chromium

echo "▸ pm2 (process manager)"
sudo npm install -g pm2

cat <<'NOTE'

✓ Build complete. NEXT (manual, once):

  1. Create ~/nawilis-spk/.env  (see DEPLOY-FREE.md for the full list). Minimum:
       MONGODB_URI=mongodb+srv://...          # your Atlas connection string
       MONGODB_DB=spk
       TURBOLY_BASE_URL=https://sandbox.turboly.com   # sandbox until verified!
       PUSH_MODE=rpa
       PUSH_APPROVE=true
       CREDENTIAL_ENC_KEY=...                  # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
       TURBOLY_USERNAME=...                    # service account WITHOUT 2FA
       TURBOLY_PASSWORD=...
       # optional: run 24/7 instead of 07:00-20:00 WIB:
       # PUSH_WINDOW_START=00:00
       # PUSH_WINDOW_END=23:59

  2. Allowlist THIS VM's public IP in Atlas -> Network Access.

  3. (If the Turboly account has 2FA) do an interactive login once on your laptop:
       npm run login:turboly
     then copy the saved session up:
       scp -r .turboly-state ubuntu@<vm-ip>:~/nawilis-spk/

  4. Seed the Turboly master data (stores/services/mechanics) so pushes use real SKUs:
       npm run seed:turboly -- ./turboly-export.json

  5. Start it 24/7:
       pm2 start ecosystem.config.cjs
       pm2 save && pm2 startup     # run the command it prints
       pm2 logs spk-worker         # watch it push
NOTE
