import type { Page, Locator } from 'playwright';
import type { Loc, Typeahead } from './selmap.js';

/** Resolve a declarative Loc into a Playwright Locator on the given root. */
export function resolve(page: Page, loc: Loc): Locator {
  switch (loc.kind) {
    case 'role':
      return page.getByRole(loc.value as Parameters<Page['getByRole']>[0], loc.name ? { name: loc.name } : undefined);
    case 'label':
      return page.getByLabel(loc.value);
    case 'placeholder':
      return page.getByPlaceholder(loc.value);
    case 'text':
      return page.getByText(loc.value, { exact: false });
    case 'css':
      return page.locator(loc.value);
    default:
      throw new Error(`Unknown locator kind: ${(loc as Loc).kind}`);
  }
}

/**
 * Drive a custom typeahead dropdown: open → type → pick the option whose text
 * matches. Works for select2-style widgets and plain typeaheads alike.
 * Returns the chosen option's text (for read-back assertions).
 */
export async function selectTypeahead(page: Page, ta: Typeahead, query: string, opts: { exact?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 8000;
  const trigger = resolve(page, ta.trigger);
  await trigger.click({ timeout });

  // Some widgets reuse the trigger as the search box; others open a separate one.
  const search = resolve(page, ta.search);
  const searchBox = (await search.count()) > 0 ? search : trigger;
  await searchBox.fill(query, { timeout }).catch(async () => {
    await searchBox.click();
    await searchBox.type(query, { delay: 20 });
  });

  const option = resolve(page, ta.optionByText(query));
  await option.first().click({ timeout });
}

/** Fill a plain input identified by a Loc. */
export async function fillInput(page: Page, loc: Loc, value: string, timeoutMs = 8000): Promise<void> {
  const el = resolve(page, loc);
  await el.fill(value, { timeout: timeoutMs });
}

/** Read the text/value at a Loc, if present. */
export async function readValue(page: Page, loc: Loc): Promise<string | null> {
  const el = resolve(page, loc);
  if ((await el.count()) === 0) return null;
  const tag = await el.first().evaluate((n) => (n as HTMLElement).tagName).catch(() => '');
  if (tag === 'INPUT' || tag === 'TEXTAREA') return (await el.first().inputValue().catch(() => null)) ?? null;
  return (await el.first().textContent().catch(() => null))?.trim() ?? null;
}

/** True if a Loc resolves to at least one visible element within the timeout. */
export async function exists(page: Page, loc: Loc, timeoutMs = 4000): Promise<boolean> {
  try {
    await resolve(page, loc).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hash the set of stable control attributes on the current form. Used by the
 * structural canary: a changed hash while all selectors still resolve means
 * Turboly shipped a UI change that hasn't broken us YET — the earliest signal.
 */
export async function hashFormControls(page: Page): Promise<string> {
  const attrs = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('input,select,textarea,button,[role="tab"]'));
    return nodes
      .map((n) => {
        const el = n as HTMLElement;
        return [el.tagName, el.getAttribute('name') ?? '', el.getAttribute('id') ?? '', el.getAttribute('placeholder') ?? '', el.getAttribute('data-testid') ?? '', (el.textContent ?? '').trim().slice(0, 24)].join('|');
      })
      .sort();
  });
  // Simple stable digest (FNV-1a) — no crypto dependency needed for a change signal.
  let h = 0x811c9dc5;
  const s = attrs.join('\n');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
