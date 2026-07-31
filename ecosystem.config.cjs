/**
 * pm2 process config for the Turboly push worker on the Oracle Free VM.
 * pm2 keeps it alive 24/7, restarts on crash, and starts on boot.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup   # survive reboots
 *   pm2 logs spk-worker       # watch it
 */
module.exports = {
  apps: [
    {
      name: 'spk-worker',
      script: 'apps/worker/dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '700M', // headless Chromium is memory-hungry
      env: { NODE_ENV: 'production' },
    },
  ],
};
