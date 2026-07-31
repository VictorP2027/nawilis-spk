#!/usr/bin/env bash
# One-time setup for the Turboly push worker on an Oracle Cloud Free VM
# (Ubuntu 22.04, Ampere ARM). Run as the default `ubuntu` user.
#
#   curl -fsSL <this file> | bash    — or copy it up and: bash vm-setup.sh
set -euo pipefail

echo "▸ system deps + Node 20 + Redis"
sudo apt-get update -y
sudo apt-get install -y curl git redis-server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo systemctl enable --now redis-server

echo "▸ clone repo (edit the URL to your GitHub repo)"
: "${REPO_URL:?set REPO_URL=git@github.com:you/nawilis-spk.git}"
git clone "$REPO_URL" ~/nawilis-spk || (cd ~/nawilis-spk && git pull)
cd ~/nawilis-spk

echo "▸ install + build core & worker"
npm install
npm run build -w @spk/core
npm --workspace @spk/worker run build
echo "▸ Playwright chromium + system libs"
npx playwright install --with-deps chromium

echo "▸ pm2"
sudo npm install -g pm2

cat <<'NOTE'

NEXT (manual, once):
  1. Create ~/nawilis-spk/.env  (see DEPLOY-FREE.md for the full list). Minimum:
       MONGODB_URI=mongodb+srv://...          # your Atlas string
       MONGODB_DB=spk
       REDIS_URL=redis://localhost:6379
       TURBOLY_BASE_URL=https://sandbox.turboly.com
       PUSH_MODE=rpa
       CREDENTIAL_ENC_KEY=...                  # 32-byte base64
       TURBOLY_USERNAME=...                    # service account (no 2FA)
       TURBOLY_PASSWORD=...
  2. Allowlist THIS VM's public IP in Atlas → Network Access.
  3. Start it:
       pm2 start ecosystem.config.cjs
       pm2 save && pm2 startup    # run the printed command
       pm2 logs spk-worker
NOTE
