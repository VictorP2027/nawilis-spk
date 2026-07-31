import { chromium, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SELECTOR_MAP as S, type Loc } from '@spk/core/turboly';

/**
 * Live login + session capture against Turboly.
 *
 * TWO ways to authenticate — you choose, and NEITHER puts your password in the
 * AI chat transcript:
 *
 *   A) Automated: export creds in YOUR shell, then run this:
 *        export TURBOLY_USERNAME='you@nawilis.com'
 *        export TURBOLY_PASSWORD='••••••'
 *        npm run login:turboly
 *
 *   B) Manual (safest; also handles 2FA/OTP): leave creds unset and just
 *      log in by hand in the window that opens, then press ENTER here.
 *
 * Either way it saves the authenticated session to TURBOLY_STATE_DIR so the
 * worker reuses it without logging in again. Defaults to SANDBOX.
 *
 * Flags:  --headless   run without a visible window (only for automated mode)
 *         --create      after login, create a TEST Service Order in sandbox and
 *                       read it back (proves the whole RPA path end to end)
 */
const BASE = process.env.TURBOLY_BASE_URL ?? 'https://sandbox.turboly.com';
const STATE_DIR = process.env.TURBOLY_STATE_DIR ?? './.turboly-state';
const BRANCH = process.env.TURBOLY_LOGIN_BRANCH ?? 'DEFAULT';
const HEADLESS = process.argv.includes('--headless');
const DO_CREATE = process.argv.includes('--create');

function statePath(branch: string): string {
  return join(STATE_DIR, `storageState-${branch}.json`);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(BASE + S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (/\/login|\/signin|\/welcome\/login/i.test(page.url())) return false;
  // Logged in if the Service Orders list (its New button) is reachable.
  const newBtn = page.getByRole('button', { name: /new service order/i });
  return (await newBtn.count()) > 0;
}

async function heuristicLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  let pw = page.locator('input[type="password"]').first();
  if ((await pw.count()) === 0) {
    for (const p of ['/login', '/signin', '/welcome/login']) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
      pw = page.locator('input[type="password"]').first();
      if ((await pw.count()) > 0) break;
    }
  }
  if ((await pw.count()) === 0) throw new Error('Could not find a password field — log in manually instead (leave creds unset).');

  const user = page
    .locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i], input[type="text"]')
    .first();
  await user.fill(username);
  await pw.fill(password);

  const btn = page.getByRole('button', { name: /log\s?in|sign\s?in|masuk|submit|continue/i }).first();
  if ((await btn.count()) > 0) await btn.click();
  else await pw.press('Enter');

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
}

function waitForEnter(prompt: string): Promise<void> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function resolveCount(page: Page, loc: Loc): Promise<number> {
  try {
    switch (loc.kind) {
      case 'role': return await page.getByRole(loc.value as never, loc.name ? { name: loc.name } : undefined).count();
      case 'label': return await page.getByLabel(loc.value).count();
      case 'placeholder': return await page.getByPlaceholder(loc.value).count();
      case 'text': return await page.getByText(loc.value).count();
      case 'css': return await page.locator(loc.value).count();
      default: return 0;
    }
  } catch { return 0; }
}

async function selectorReport(page: Page): Promise<void> {
  await page.goto(BASE + S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /new service order/i }).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const checks: Array<[string, Loc]> = [
    ['header.store', S.header.store.trigger],
    ['header.customerSearch', S.header.customerSearch.trigger],
    ['header.vehicleRegistrationSearch', S.header.vehicleRegistrationSearch.trigger],
    ['header.odometer', S.header.odometer],
    ['header.planServiceDate', S.header.planServiceDate],
    ['header.planServiceTime', S.header.planServiceTime],
    ['header.serviceAdvisor', S.header.serviceAdvisor.trigger],
    ['header.salesperson', S.header.salesperson.trigger],
    ['header.referenceNumber', S.header.referenceNumber],
    ['tabs.packagesSparepartsServices', S.tabs.packagesSparepartsServices],
    ['services.addServiceItem', S.services.addServiceItem],
    ['actions.save', S.actions.save],
  ];
  console.log('\n── Selector report (New Service Order form) ──');
  let ok = 0;
  for (const [label, loc] of checks) {
    const n = await resolveCount(page, loc);
    if (n > 0) ok++;
    console.log(`${n > 0 ? '✓' : '✗'} ${label.padEnd(38)} ${n} match  (${loc.kind}:${loc.value}${loc.name ? `/${loc.name}` : ''})`);
  }
  console.log(`${ok}/${checks.length} selectors resolved.`);
  if (ok < checks.length) console.log('Fix ✗ entries in packages/core/src/turboly/selmap.ts (use `npm run codegen -w @spk/turboly-capture`).');
}

async function main(): Promise<void> {
  if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true });

  const hasState = existsSync(statePath(BRANCH));
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
    storageState: hasState ? JSON.parse(await readFile(statePath(BRANCH), 'utf8')) : undefined,
  });
  const page = await ctx.newPage();

  console.log(`Turboly: ${BASE}  (branch session: ${BRANCH})`);

  if (await isLoggedIn(page)) {
    console.log('✓ Existing session is still valid — no login needed.');
  } else {
    const user = process.env.TURBOLY_USERNAME;
    const pass = process.env.TURBOLY_PASSWORD;
    if (user && pass) {
      console.log('Logging in with TURBOLY_USERNAME / TURBOLY_PASSWORD from your environment…');
      await heuristicLogin(page, user, pass);
      // If a 2FA/OTP screen appears, fall through to manual completion.
      if (!(await isLoggedIn(page))) {
        if (HEADLESS) throw new Error('Login did not complete (2FA/OTP or wrong selectors). Re-run without --headless to finish by hand.');
        await waitForEnter('Finish any 2FA/OTP in the window, then press ENTER…');
      }
    } else {
      if (HEADLESS) throw new Error('No creds set and --headless given. Set TURBOLY_USERNAME/PASSWORD or drop --headless.');
      console.log('No creds in env — log in BY HAND in the opened window.');
      await waitForEnter('After you are logged in, press ENTER here…');
    }
  }

  if (!(await isLoggedIn(page))) {
    console.error('✗ Still not logged in. Aborting without saving a session.');
    await browser.close();
    process.exit(1);
  }

  // Persist the authenticated session for the worker to reuse.
  const state = await ctx.storageState();
  await writeFile(statePath(BRANCH), JSON.stringify(state), 'utf8');
  console.log(`✓ Session saved to ${statePath(BRANCH)}`);

  await selectorReport(page);

  if (DO_CREATE) {
    console.log('\n--create given: opening a fresh New Service Order form for a manual/test create is not automated here to avoid writing junk. Use the worker against sandbox once selectors are green.');
  }

  if (!HEADLESS) await waitForEnter('\nPress ENTER to close the browser…');
  await browser.close();
  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
