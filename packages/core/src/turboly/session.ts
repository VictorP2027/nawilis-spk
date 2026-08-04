import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { SELECTOR_MAP } from './selmap.js';
import { collections, getDb } from '../mongo.js';

/**
 * Per-branch Turboly sessions. One BrowserContext per worker, page concurrency
 * 1 (ERP session state means parallel pages cross-talk onto the wrong record).
 * Cookies are persisted to storageState so we log in rarely, not per record.
 *
 * A LOGIN IS THE EXPENSIVE OPERATION HERE, and not because of its own seconds:
 * Turboly allows ONE SESSION PER USER, so every login kicks whoever held the
 * account — the human who just opened Turboly, the hourly catalog sync, the web
 * app's prefill — and a kicked worker throws away its whole attempt and waits
 * for another 60-90s GitHub runner. Everything below exists to make logins rare.
 */

/** Full storage state as Playwright hands it back — cookies + localStorage. */
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
type CookieList = Parameters<BrowserContext['addCookies']>[0];

/**
 * Browser storage state, keyed by ACCOUNT (not branch): `.turboly-state/` is
 * gitignored and no workflow caches it, so every GitHub Actions run starts with
 * an empty state dir and used to pay a full form login — plus the kick that
 * comes with it — before doing any work at all. Mongo is the only store both
 * the runner and the web app can see.
 */
const SESSION_STATE_COLLECTION = 'turboly_sessions';

/**
 * The cookie doc apps/web/lib/turbolyLookup.ts and turboly/httpRegister.ts
 * already share. The browser session was the one participant NOT in on it, so
 * it logged in against the other two and they logged in against it.
 */
const HTTP_SESSION_COLLECTION = 'turboly_http_session';

/**
 * Cheap authenticated probe. Turboly's own select2 endpoint (the one flowSink
 * already trusts for the duplicate guard): a few hundred bytes of JSON instead
 * of rendering the Service Order list — a full ERP grid plus the fixed 900ms
 * settle that followed it. One corporate registration calls ensureLoggedIn()
 * 3-5x (flow-once, the company dedupe probe, the retail dedupe probe, each
 * flowSink.open()), so the check itself was several seconds per job.
 */
const AUTH_PROBE_PATH = '/lookup/customers.json?search_term=__spk_auth_probe__&page_limit=1&page=1';

/**
 * How long a positive check is trusted without re-probing. The window is only
 * reached when nothing observable changed: any navigation onto a sign-in or
 * /dashboard URL clears it, and so does another process taking the shared
 * cookie (see memoStillValid). 60s covers one job's worth of back-to-back
 * ensureLoggedIn() calls; being wrong costs one extra navigation, never a
 * missed re-login.
 */
const LOGIN_MEMO_MS = 60_000;

/**
 * 1x1 transparent GIF served in place of every image. Images are ~nothing to a
 * form-filling robot but they are most of the bytes on a Turboly page. Serving
 * a real (tiny) image rather than aborting the request keeps every <img> a
 * loaded, non-zero-size box — locators.exists() waits for state:'visible', and
 * a 0x0 collapsed image could flip a control from present to absent.
 */
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

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

/** A stored session we could try, newest first. `at` is only used to rank them. */
interface StateCandidate {
  src: string;
  at: number;
  state: StorageState;
}

/** The `k=v; k2=v2` header form the HTTP paths cache, from a storage state. */
function cookieHeaderFrom(state: StorageState, baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return '';
  }
  return state.cookies
    .filter((c) => c.domain && (host === c.domain || host.endsWith(c.domain.replace(/^\./, ''))))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Inverse of cookieHeaderFrom. The shared doc stores only `k=v` pairs, so the
 * attributes are reconstructed: session-scoped (`expires: -1`) and host-only,
 * which is what Devise sets. httpOnly is dropped deliberately — it governs JS
 * visibility inside the page, never what goes out in the Cookie header.
 */
function stateFromCookieHeader(cookie: string, baseUrl: string): StorageState | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const cookies = cookie
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      if (i <= 0) return null;
      return {
        name: p.slice(0, i),
        value: p.slice(i + 1),
        domain: url.hostname,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: url.protocol === 'https:',
        sameSite: 'Lax' as const,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (!cookies.length) return null;
  return { cookies, origins: [] };
}

/** Cookie names+values only — enough to tell "same session" from "someone re-logged in". */
function signature(state: StorageState): string {
  return (state?.cookies ?? [])
    .map((c) => `${c.name}=${c.value}`)
    .sort()
    .join('|');
}

/** A hand-edited or truncated state file must not take the whole session down. */
function isStorageState(v: unknown): v is StorageState {
  return !!v && Array.isArray((v as StorageState).cookies);
}

export class TurbolySession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private jobsSinceRecycle = 0;

  /** Stored sessions not yet tried — each one is a login we might not have to pay. */
  private pendingStates: StateCandidate[] = [];
  /** When the last positive login check happened, and what the shared cookie was then. */
  private verifiedAt = 0;
  private verifiedMarker: string | null = null;
  /** Last cookie header written to the shared doc — so re-persisting is a no-op. */
  private publishedCookie: string | null = null;
  /** undefined = not resolved yet; null = unknown (no creds anywhere). */
  private usernameCache: string | null | undefined;

  constructor(private readonly cfg: SessionConfig) {}

  /** Where THIS branch's session is written. */
  private get statePath(): string {
    return join(this.cfg.stateDir, `storageState-${this.cfg.branchCode}.json`);
  }
  /** Shared session (from `npm run login:turboly`) used before a branch has its own. */
  private get sharedStatePath(): string {
    return join(this.cfg.stateDir, `storageState-DEFAULT.json`);
  }

  async start(): Promise<void> {
    if (!existsSync(this.cfg.stateDir)) await mkdir(this.cfg.stateDir, { recursive: true });
    // The launch is ~0.5s of wall clock that does not depend on which stored
    // session we pick, and finding the freshest one now costs a Mongo round
    // trip — so the two overlap instead of adding up.
    const [browser, candidates] = await Promise.all([chromium.launch({ headless: true }), this.loadCandidates()]);
    this.browser = browser;
    this.pendingStates = candidates;
    const first = this.pendingStates.shift();
    this.context = await browser.newContext({
      storageState: first?.state,
      userAgent: `Mozilla/5.0 (compatible) ${this.cfg.userAgentSuffix}`,
      baseURL: this.cfg.baseUrl,
      viewport: { width: 1440, height: 900 },
    });
    await this.trimSubresources(this.context);
    this.page = await this.context.newPage();
    this.watchForKick(this.page);
    this.verifiedAt = 0;
    this.verifiedMarker = null;
  }

  page_(): Page {
    if (!this.page) throw new Error('Session not started');
    return this.page;
  }

  /**
   * Forget the cached login check. For code that knows it just created a SECOND
   * session on this account (the HTTP register path logging in for itself): that
   * kicks this browser and nothing here would otherwise observe it.
   */
  invalidateLoginCheck(): void {
    this.verifiedAt = 0;
  }

  /**
   * The live browser session as the `k=v; …` header the HTTP paths use, so they
   * can ride this session instead of logging in and kicking it. Empty string
   * when there is nothing to share.
   */
  async httpCookieHeader(): Promise<string> {
    if (!this.context) return '';
    return cookieHeaderFrom(await this.context.storageState(), this.cfg.baseUrl);
  }

  // ── login checks ─────────────────────────────────────────────────────────

  /**
   * Cheap check first, heavy page check only when the cheap one is ambiguous.
   * The ambiguity path matters: during a Turboly maintenance window every route
   * answers with HTML, and calling that "logged out" would send us into a form
   * login that fails with a PERMANENT AuthChallengeError instead of letting the
   * caller recognise maintenance and retry.
   */
  private async verifyLoggedIn(): Promise<boolean> {
    const quick = await this.probeAuth();
    if (quick !== null) return quick;
    return this.loggedInByPage();
  }

  /** true/false when the answer is unambiguous, null when it isn't. */
  private async probeAuth(): Promise<boolean | null> {
    const ctx = this.context;
    if (!ctx) return null;
    try {
      // context.request shares this context's cookie jar in BOTH directions, so
      // a rotated session cookie stays in sync with the page.
      const res = await ctx.request.get(`${this.cfg.baseUrl}${AUTH_PROBE_PATH}`, {
        headers: { accept: 'application/json' },
        maxRedirects: 0,
        timeout: 15_000,
      });
      const status = res.status();
      // An authenticated JSON call never redirects. Kicked sessions bounce to
      // /users/sign_in — or, on this tenant, to /dashboard (see loggedInByPage).
      if (status >= 300 && status < 400) return false;
      if (status === 401 || status === 403) return false;
      if (status === 200 && /json/i.test(res.headers()['content-type'] ?? '')) return true;
      return null;
    } catch {
      return null;
    }
  }

  /** Robust logged-in check: on the SO list, not on a login URL, New button present. */
  private async loggedInByPage(): Promise<boolean> {
    const page = this.page_();
    // Logged in iff visiting a protected page does NOT bounce us to the login.
    const target = SELECTOR_MAP.routes.serviceOrdersList;
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(900);
    const url = page.url();
    if (/sign_in|sign-in|\/login|\/signin/i.test(url)) return false;
    // A KICKED session doesn't bounce to /users/sign_in — Turboly redirects
    // protected pages to /dashboard and overlays a login modal. Treating that
    // as "logged in" made ensureLoggedIn() a no-op, so every later navigation
    // silently landed on the dashboard (found live: create_wo 3× redirect).
    if (/\/dashboard\b/i.test(url) && !/dashboard/i.test(target)) return false;
    const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '').catch(() => '')) as string;
    if (/you have been logged out|please login again|sign in or sign up/i.test(body)) return false;
    return true;
  }

  /**
   * Is the last positive check still good? Only if BOTH: it is recent, and the
   * shared cookie doc still holds the session we verified. That doc is the one
   * place a competing login shows up (the web app's prefill and the HTTP
   * register both write it), so a changed marker means re-check for real.
   * A Mongo read failure is not evidence — fall through and probe.
   */
  private async memoStillValid(): Promise<boolean> {
    if (!this.verifiedAt || Date.now() - this.verifiedAt > LOGIN_MEMO_MS) return false;
    const marker = await this.sharedCookieDoc().then((d) => d?.cookie ?? null).catch(() => undefined);
    if (marker === undefined) return false;
    return marker === this.verifiedMarker;
  }

  private async rememberVerified(): Promise<void> {
    this.verifiedAt = Date.now();
    this.verifiedMarker = await this.sharedCookieDoc().then((d) => d?.cookie ?? null).catch(() => null);
  }

  /** A navigation that lands on a login/dashboard URL is the kick we can see. */
  private watchForKick(page: Page): void {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (/sign_in|sign-in|\/login\b|\/signin|\/dashboard\b/i.test(frame.url())) this.verifiedAt = 0;
    });
  }

  /**
   * Ensure we're logged in. Order of preference:
   *   1. The session already in this context.
   *   2. Any OTHER stored session for this account (branch file, shared file,
   *      Mongo, the shared HTTP cookie) — replaying a cookie kicks nobody, so
   *      trying all of them costs ~300ms each and can save a login outright.
   *   3. Credentials — Mongo (encrypted) first, else TURBOLY_USERNAME/PASSWORD env.
   * A 2FA/OTP challenge can't be automated → AuthChallengeError so a human re-runs
   * `npm run login:turboly` to refresh the saved session.
   */
  async ensureLoggedIn(): Promise<void> {
    if (await this.memoStillValid()) return;
    if (await this.verifyLoggedIn()) {
      await this.rememberVerified();
      return;
    }

    while (this.pendingStates.length) {
      const cand = this.pendingStates.shift();
      if (!cand || !(await this.adopt(cand))) continue;
      if (await this.verifyLoggedIn()) {
        await this.rememberVerified();
        await this.persistState();
        return;
      }
    }

    const page = this.page_();
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
      // The selector map's route first: it is the confirmed Devise path, so the
      // guessed ones below are only reached on a tenant that moved it.
      for (const p of [SELECTOR_MAP.routes.login, '/login', '/signin', '/welcome/login']) {
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

    if (!(await this.verifyLoggedIn())) {
      throw new AuthChallengeError(`Login did not complete for ${this.cfg.branchCode} (2FA/OTP or wrong credentials). Run \`npm run login:turboly\`.`);
    }
    // This login just kicked every other holder of the account — publish before
    // anything else notices, so they replay this session instead of logging in
    // and kicking us straight back.
    await this.persistState();
    await this.rememberVerified();
  }

  /** Swap the context's cookies for a stored session. False = nothing to try. */
  private async adopt(cand: StateCandidate): Promise<boolean> {
    const ctx = this.context;
    if (!ctx || !cand.state.cookies.length) return false;
    try {
      await ctx.clearCookies();
      await ctx.addCookies(cand.state.cookies as unknown as CookieList);
      return true;
    } catch {
      return false;
    }
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

  /**
   * Just the username — no CREDENTIAL_ENC_KEY, no decrypt. It is the identity a
   * stored session belongs to, and "one session per user" means that identity,
   * not the branch, is what decides whether two sessions can share a cookie.
   */
  private async resolveUsername(): Promise<string | null> {
    if (this.usernameCache !== undefined) return this.usernameCache;
    let fromDb: string | null = null;
    try {
      fromDb = (await collections.tbCredentials().findOne({ _id: this.cfg.branchCode }))?.username ?? null;
    } catch {
      // Mongo isn't connected in the capture/login tools — env is the fallback.
    }
    this.usernameCache = fromDb ?? process.env.TURBOLY_USERNAME ?? null;
    return this.usernameCache;
  }

  /**
   * Sessions are stored per ACCOUNT. Every branch authenticates with the SAME
   * .env credentials unless tb_credentials says otherwise, so a per-branch key
   * made BranchFlowRigs pay a fresh login on every branch swap for a session it
   * already held. Falls back to the branch when the username is unknown.
   */
  private async accountKey(): Promise<string> {
    const user = await this.resolveUsername();
    let host = this.cfg.baseUrl;
    try {
      host = new URL(this.cfg.baseUrl).host;
    } catch {
      /* keep the raw string — it is only a key */
    }
    return `${host}|${user ?? `branch:${this.cfg.branchCode}`}`;
  }

  // ── stored sessions ──────────────────────────────────────────────────────

  private async fileCandidate(path: string, src: string): Promise<StateCandidate | null> {
    if (!existsSync(path)) return null;
    try {
      const [raw, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const state: unknown = JSON.parse(raw);
      return isStorageState(state) ? { src, at: st.mtimeMs, state } : null;
    } catch {
      return null;
    }
  }

  private async sharedCookieDoc(): Promise<{ cookie?: string; at?: string; username?: string } | null> {
    return (await getDb()
      .collection(HTTP_SESSION_COLLECTION)
      .findOne({ _id: 'cookie' } as never)) as { cookie?: string; at?: string; username?: string } | null;
  }

  /**
   * Every stored session for this account, freshest first. Mongo failures are
   * swallowed on purpose: the capture/login tools never call connect(), and a
   * missing stored session is a slow run, not a broken one.
   */
  private async loadCandidates(): Promise<StateCandidate[]> {
    const out: StateCandidate[] = [];
    const [branchFile, sharedFile] = await Promise.all([
      this.fileCandidate(this.statePath, 'file:branch'),
      this.fileCandidate(this.sharedStatePath, 'file:shared'),
    ]);
    if (branchFile) out.push(branchFile);
    if (sharedFile) out.push(sharedFile);

    try {
      const doc = (await getDb()
        .collection(SESSION_STATE_COLLECTION)
        .findOne({ _id: await this.accountKey() } as never)) as { state?: string; at?: string } | null;
      const state: unknown = doc?.state ? JSON.parse(doc.state) : null;
      if (isStorageState(state)) out.push({ src: 'mongo:state', at: Date.parse(doc?.at ?? '') || 0, state });
    } catch {
      /* no Mongo, or nothing stored yet */
    }

    try {
      const doc = await this.sharedCookieDoc();
      // ONLY a cookie we know is ours. turbolyLookup.ts may be configured with a
      // dedicated TURBOLY_LOOKUP_USERNAME, and adopting THAT would make the RPA
      // act as the wrong Turboly user — wrong stores, wrong permissions. Docs
      // written before this field existed carry no username and are skipped.
      const me = await this.resolveUsername();
      if (doc?.cookie && me && doc.username === me) {
        const state = stateFromCookieHeader(doc.cookie, this.cfg.baseUrl);
        if (state) out.push({ src: 'mongo:httpCookie', at: Date.parse(doc.at ?? '') || 0, state });
      }
    } catch {
      /* no Mongo — fall back to files */
    }

    out.sort((a, b) => b.at - a.at);
    const seen = new Set<string>();
    return out.filter((c) => {
      const sig = signature(c.state);
      if (!sig || seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  /**
   * Persist the live session everywhere it can save a future login: the branch
   * file (this process), `turboly_sessions` (the next cold runner), and the
   * shared cookie doc the web app and the HTTP register already read.
   *
   * Publishing is fail-safe in both directions — a cookie the other side cannot
   * use just makes it log in, which is exactly what it does today.
   */
  async persistState(): Promise<void> {
    if (!this.context) return;
    const state = await this.context.storageState();
    await writeFile(this.statePath, JSON.stringify(state), 'utf8');

    const cookie = cookieHeaderFrom(state, this.cfg.baseUrl);
    // noteJobDone() runs this after EVERY job; the cookie only changes on a
    // login, so the two Mongo writes below are otherwise skipped entirely.
    if (!cookie || cookie === this.publishedCookie) return;
    this.publishedCookie = cookie;

    const at = new Date().toISOString();
    try {
      const username = await this.resolveUsername();
      await getDb()
        .collection(SESSION_STATE_COLLECTION)
        .updateOne(
          { _id: await this.accountKey() } as never,
          { $set: { state: JSON.stringify(state), at, baseUrl: this.cfg.baseUrl, branchCode: this.cfg.branchCode, username } },
          { upsert: true },
        );
      await getDb()
        .collection(HTTP_SESSION_COLLECTION)
        .updateOne({ _id: 'cookie' } as never, { $set: { cookie, at, username } }, { upsert: true });
      this.verifiedMarker = cookie;
    } catch {
      // Best-effort: a session that only lives in the local file is the old
      // behaviour, not a failure worth aborting a push for.
      this.publishedCookie = null;
    }
  }

  // ── browser weight ───────────────────────────────────────────────────────

  /**
   * Images are most of the bytes on a Turboly page and none of the meaning to a
   * robot that fills forms. Stylesheets, fonts and scripts are deliberately NOT
   * touched: select2 is jQuery-driven, and Turboly's icon-only controls are
   * font glyphs — dropping either changes which elements resolve.
   * TURBOLY_LOAD_IMAGES=1 turns this off without a code change.
   */
  private async trimSubresources(ctx: BrowserContext): Promise<void> {
    if (process.env.TURBOLY_LOAD_IMAGES === '1') return;
    await ctx.route(
      (url) => /\.(png|jpe?g|gif|webp|bmp|ico|avif)(\?|$)/i.test(url.pathname + url.search),
      async (route) => {
        const type = route.request().resourceType();
        if (type !== 'image') return route.continue();
        await route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL_GIF });
      },
    );
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
    this.verifiedAt = 0;
    this.verifiedMarker = null;
  }
}
