import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { SELECTOR_MAP } from './selmap.js';
import { exists } from './locators.js';
import { collections } from '../mongo.js';

/**
 * Per-branch Turboly sessions. One BrowserContext per worker, page concurrency
 * 1 (ERP session state means parallel pages cross-talk onto the wrong record).
 * Cookies are persisted to storageState so we log in rarely, not per record.
 */

export interface SessionConfig {
  baseUrl: string;
  stateDir: string;
  userAgentSuffix: string;
  branchCode: string;
}

export class AuthChallengeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthChallengeError';
  }
}

function decrypt(enc: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const raw = Buffer.from(enc, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export class TurbolySession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private jobsSinceRecycle = 0;

  constructor(private readonly cfg: SessionConfig) {}

  /** Where THIS branch's session is written. */
  private get statePath(): string {
    return join(this.cfg.stateDir, `storageState-${this.cfg.branchCode}.json`);
  }
  /** Shared session (from `npm run login:turboly`) used before a branch has its own. */
  private get sharedStatePath(): string {
    return join(this.cfg.stateDir, `storageState-DEFAULT.json`);
  }
  /** Prefer the branch's own session, else fall back to the shared one. */
  private loadableStatePath(): string | null {
    if (existsSync(this.statePath)) return this.statePath;
    if (existsSync(this.sharedStatePath)) return this.sharedStatePath;
    return null;
  }

  async start(): Promise<void> {
    if (!existsSync(this.cfg.stateDir)) await mkdir(this.cfg.stateDir, { recursive: true });
    this.browser = await chromium.launch({ headless: true });
    const src = this.loadableStatePath();
    const storageState = src ? JSON.parse(await readFile(src, 'utf8')) : undefined;
    this.context = await this.browser.newContext({
      storageState,
      userAgent: `Mozilla/5.0 (compatible) ${this.cfg.userAgentSuffix}`,
      baseURL: this.cfg.baseUrl,
      viewport: { width: 1440, height: 900 },
    });
    this.page = await this.context.newPage();
  }

  page_(): Page {
    if (!this.page) throw new Error('Session not started');
    return this.page;
  }

  /** Robust logged-in check: on the SO list, not on a login URL, New button present. */
  private async loggedIn(): Promise<boolean> {
    const page = this.page_();
    await page.goto(SELECTOR_MAP.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (/sign_in|sign-in|\/login/i.test(page.url())) return false;
    return exists(page, SELECTOR_MAP.routes.newServiceOrderButton, 4000);
  }

  /**
   * Ensure we're logged in. Order of preference:
   *   1. A reused saved session (from `npm run login:turboly` or a prior run).
   *   2. Credentials — Mongo (encrypted) first, else TURBOLY_USERNAME/PASSWORD env.
   * A 2FA/OTP challenge can't be automated → AuthChallengeError so a human re-runs
   * `npm run login:turboly` to refresh the saved session.
   */
  async ensureLoggedIn(): Promise<void> {
    const page = this.page_();
    if (await this.loggedIn()) return;

    const cred = await this.resolveCredentials();
    if (!cred) {
      throw new AuthChallengeError(
        `No valid Turboly session or credentials for ${this.cfg.branchCode}. ` +
          `Run \`npm run login:turboly\` (or store creds with set-credential.ts).`,
      );
    }

    // Heuristic login — resilient to the exact login-field markup.
    await page.goto(this.cfg.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    let pw = page.locator('input[type="password"]').first();
    if ((await pw.count()) === 0) {
      for (const p of ['/login', '/signin', '/welcome/login']) {
        await page.goto(this.cfg.baseUrl + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
        pw = page.locator('input[type="password"]').first();
        if ((await pw.count()) > 0) break;
      }
    }
    if ((await pw.count()) === 0) throw new AuthChallengeError('Login form not found — run `npm run login:turboly` to log in by hand.');
    const user = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[type="text"]').first();
    await user.fill(cred.username);
    await pw.fill(cred.password);
    const btn = page.getByRole('button', { name: /log\s?in|sign\s?in|masuk|submit|continue/i }).first();
    if ((await btn.count()) > 0) await btn.click();
    else await pw.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => {});

    if (!(await this.loggedIn())) {
      throw new AuthChallengeError(`Login did not complete for ${this.cfg.branchCode} (2FA/OTP or wrong credentials). Run \`npm run login:turboly\`.`);
    }
    await this.persistState();
  }

  private async resolveCredentials(): Promise<{ username: string; password: string } | null> {
    const cred = await collections.tbCredentials().findOne({ _id: this.cfg.branchCode });
    if (cred) {
      const keyB64 = process.env.CREDENTIAL_ENC_KEY;
      if (!keyB64) throw new Error('CREDENTIAL_ENC_KEY not set');
      return { username: cred.username, password: decrypt(cred.passwordEnc, keyB64) };
    }
    const u = process.env.TURBOLY_USERNAME;
    const p = process.env.TURBOLY_PASSWORD;
    if (u && p) return { username: u, password: p };
    return null;
  }

  async persistState(): Promise<void> {
    if (!this.context) return;
    const state = await this.context.storageState();
    await writeFile(this.statePath, JSON.stringify(state), 'utf8');
  }

  /** Recycle the browser every ~50 jobs to avoid memory/DOM drift. */
  async noteJobDone(recycleEvery = 50): Promise<void> {
    this.jobsSinceRecycle++;
    await this.persistState();
    if (this.jobsSinceRecycle >= recycleEvery) {
      await this.restart();
      this.jobsSinceRecycle = 0;
    }
  }

  private async restart(): Promise<void> {
    await this.dispose();
    await this.start();
    await this.ensureLoggedIn();
  }

  async dispose(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
