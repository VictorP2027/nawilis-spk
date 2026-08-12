import { chromium } from 'playwright';
import { SELECTOR_MAP as S, type Loc } from '@spk/core/turboly';

/**
 * Selector verification / capture helper.
 *
 * Opens a HEADED browser at live.turboly.com so you can log in by hand
 * (safest — no credentials on disk), then navigates to a New Service Order form
 * and checks that every locator in SELECTOR_MAP resolves. It prints a ✓/✗ report
 * so you know exactly which entries in packages/core/src/turboly/selmap.ts need
 * adjusting — the ONE file that encodes Turboly's DOM.
 *
 *   npm run capture:turboly
 *
 * Tip: for locators marked ✗, run `npm run codegen -w @spk/turboly-capture`,
 * click the control, and copy Playwright's suggested locator into selmap.ts.
 */
const BASE = process.env.TURBOLY_BASE_URL ?? 'https://live.turboly.com';

function describe(loc: Loc): string {
  return `${loc.kind}(${loc.value}${loc.name ? `, name=${loc.name}` : ''})${loc.note ? ` [${loc.note}]` : ''}`;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  console.log(`\nOpening ${BASE}${S.routes.salesMenu}`);
  console.log('→ Log in by hand in the opened window, then return here and press ENTER.\n');
  await page.goto(S.routes.salesMenu, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForEnter();

  console.log(`Navigating to Service Orders → New Service Order …`);
  await page.goto(S.routes.serviceOrdersList, { waitUntil: 'domcontentloaded' });
  try {
    await page.getByRole('button', { name: 'New Service Order' }).click({ timeout: 10000 });
  } catch {
    console.log('⚠ Could not click "New Service Order" — check routes.newServiceOrderButton');
  }
  await page.waitForTimeout(1500);

  const checks: Array<{ label: string; loc: Loc }> = [
    { label: 'header.store.trigger', loc: S.header.store.trigger },
    { label: 'header.customerSearch.trigger', loc: S.header.customerSearch.trigger },
    { label: 'header.addNewCustomerButton', loc: S.header.addNewCustomerButton },
    { label: 'header.vehicleRegistrationSearch.trigger', loc: S.header.vehicleRegistrationSearch.trigger },
    { label: 'header.planServiceDate', loc: S.header.planServiceDate },
    { label: 'header.planServiceTime', loc: S.header.planServiceTime },
    { label: 'header.serviceAdvisor.trigger', loc: S.header.serviceAdvisor.trigger },
    { label: 'header.salesperson.trigger', loc: S.header.salesperson.trigger },
    { label: 'header.referenceNumber', loc: S.header.referenceNumber },
    { label: 'header.odometer', loc: S.header.odometer },
    { label: 'header.notes', loc: S.header.notes },
    { label: 'tabs.packagesSparepartsServices', loc: S.tabs.packagesSparepartsServices },
    { label: 'services.addServiceItem', loc: S.services.addServiceItem },
    { label: 'actions.save', loc: S.actions.save },
    { label: 'actions.approve', loc: S.actions.approve },
    { label: 'savedDocNumber', loc: S.savedDocNumber },
  ];

  console.log('\n── Selector report ─────────────────────────────');
  let ok = 0;
  for (const c of checks) {
    const found = await resolveCount(page, c.loc);
    if (found > 0) ok++;
    console.log(`${found > 0 ? '✓' : '✗'} ${c.label.padEnd(40)} ${found} match(es)  ${describe(c.loc)}`);
  }
  console.log('────────────────────────────────────────────────');
  console.log(`${ok}/${checks.length} resolved.`);
  if (ok < checks.length) {
    console.log('\nFor each ✗: run  npm run codegen -w @spk/turboly-capture  , click the control,');
    console.log('and paste Playwright\'s locator into packages/core/src/turboly/selmap.ts.');
  } else {
    console.log('\nAll good. You can set PUSH_MODE=rpa and run a sandbox smoke test.');
  }

  console.log('\nPress ENTER to close the browser.');
  await waitForEnter();
  await browser.close();
}

async function resolveCount(page: import('playwright').Page, loc: Loc): Promise<number> {
  try {
    switch (loc.kind) {
      case 'role':
        return await page.getByRole(loc.value as never, loc.name ? { name: loc.name } : undefined).count();
      case 'label':
        return await page.getByLabel(loc.value).count();
      case 'placeholder':
        return await page.getByPlaceholder(loc.value).count();
      case 'text':
        return await page.getByText(loc.value).count();
      case 'css':
        return await page.locator(loc.value).count();
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
