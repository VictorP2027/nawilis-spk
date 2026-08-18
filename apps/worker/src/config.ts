import type { PushMode } from '@spk/core';

// Load the monorepo-root .env so MONGODB_URI/REDIS_URL/Turboly creds are present
// whether the worker runs from src (tsx) or dist (node).
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  /* no .env — env must be provided another way */
}

function num(v: string | undefined, d: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

export const config = {
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  mongoDb: process.env.MONGODB_DB ?? 'spk',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  pushMode: (process.env.PUSH_MODE ?? 'manual') as PushMode,
  turbolyBaseUrl: process.env.TURBOLY_BASE_URL ?? 'https://live.turboly.com',
  turbolyStateDir: process.env.TURBOLY_STATE_DIR ?? './.turboly-state',
  userAgentSuffix: process.env.PUSH_USER_AGENT_SUFFIX ?? 'NawilisSPKBridge/0.1 (+ops@nawilis.com)',
  screenshotDir: process.env.PUSH_SCREENSHOT_DIR ?? './.turboly-state/screenshots',

  /** DRAFT → APPROVED after save (fully-automatic). Set false to leave DRAFT for human approve. */
  approveAfterSave: (process.env.PUSH_APPROVE ?? 'true') === 'true',

  /**
   * One car, one Service Order (Jane, Turboly, 2026-08-18). When an SPK arrives
   * for a car whose Check & Go was already pushed within the window, its lines
   * are APPENDED to that order instead of opening a second one. Off = the old
   * behaviour: every document is its own order.
   */
  mergeIntoCheckGo: (process.env.MERGE_INTO_CHECKGO_SO ?? 'true') === 'true',
  /** How long after the Check & Go a same-car SPK still counts as the same visit. */
  mergeWindowHours: num(process.env.MERGE_WINDOW_HOURS, 24),

  // Concurrency
  maxBrowserWorkers: num(process.env.MAX_BROWSER_WORKERS, 6),
  /** For RPA this MUST be 1 per branch account (one session, page concurrency 1). */
  maxWorkersPerBranch: num(process.env.MAX_WORKERS_PER_BRANCH, 1),
  leaseTtlMs: num(process.env.LEASE_TTL_MS, 600_000),
  canaryIntervalMs: num(process.env.CANARY_INTERVAL_MS, 300_000),

  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 15_000),

  // Business-hours push window (WIB, UTC+7)
  windowStart: process.env.PUSH_WINDOW_START ?? '07:00',
  windowEnd: process.env.PUSH_WINDOW_END ?? '20:00',

  alert: {
    whatsappEnabled: (process.env.ALERT_WHATSAPP_ENABLED ?? 'false') === 'true',
    whatsappUrl: process.env.WHATSAPP_BSP_URL ?? '',
    whatsappToken: process.env.WHATSAPP_BSP_TOKEN ?? '',
    emailTo: process.env.ALERT_EMAIL_TO ?? 'ops@nawilis.com',
  },
} as const;

/** True if `now` (ms) is inside the WIB business-hours push window. */
export function inPushWindow(nowMs = Date.now()): boolean {
  const wib = new Date(nowMs + 7 * 3600 * 1000);
  const mins = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  const [sh, sm] = config.windowStart.split(':').map(Number);
  const [eh, em] = config.windowEnd.split(':').map(Number);
  return mins >= (sh! * 60 + sm!) && mins < (eh! * 60 + em!);
}
