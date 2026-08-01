/**
 * pm2 process config for the Turboly push worker on the Oracle Free VM.
 * pm2 keeps it alive 24/7, restarts on crash, and starts on boot.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup   # survive reboots
 *   pm2 logs spk-worker       # watch it
 *
 * Runs the Redis-free push loop (apps/worker/dist/push-loop.js): polls Atlas
 * for `queued` SPKs and pushes+verifies each to Turboly. No Redis needed.
 * Env is loaded from the repo-root .env by the worker itself (config.ts).
 */
module.exports = {
  apps: [
    {
      name: 'spk-worker',
      script: 'apps/worker/dist/push-loop.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '1500M', // headless Chromium is memory-hungry (use A1.Flex 6GB+)
      env: { NODE_ENV: 'production' },
    },
  ],
};
