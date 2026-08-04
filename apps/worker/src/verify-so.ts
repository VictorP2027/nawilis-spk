import { connect, close } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * Independent proof that a Service Order really is APPROVED — a fresh session,
 * a fresh navigation, and the workflow bar read straight off the page. Used to
 * check the pusher's own approve claim rather than trust it.
 *
 *   node --import tsx apps/worker/src/verify-so.ts <url> [<url>…]
 */
async function main(): Promise<void> {
  const urls = process.argv.slice(2).filter((a) => a.startsWith('http'));
  await connect(config.mongoUri, config.mongoDb);
  const s = new TurbolySession({
    baseUrl: config.turbolyBaseUrl,
    stateDir: config.turbolyStateDir,
    userAgentSuffix: config.userAgentSuffix,
    branchCode: 'NWL-BKS',
  });
  await s.start();
  await s.ensureLoggedIn();
  const page = s.page_();
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const info = (await page.evaluate(`(() => {
      const chips = Array.from(document.querySelectorAll('span, li, div'))
        .filter((el) => /^(draft|approved|cancelled)$/i.test((el.innerText || '').trim()) && el.children.length === 0)
        .map((el) => (el.innerText || '').trim().toUpperCase() + (/(^|[\\s_-])(active|current|selected)([\\s_-]|$)/i.test((el.className || '') + ' ' + (el.parentElement ? el.parentElement.className || '' : '')) ? '*' : ''));
      const actions = Array.from(document.querySelectorAll('a, button')).map((n) => (n.innerText || '').trim()).filter((t) => /^(approve|cancel|create work order|edit)$/i.test(t));
      const body = document.body ? document.body.innerText : '';
      const no = (body.match(/\\bSRO\\/[A-Z0-9]{2,6}\\/\\d{4,}\\b/) || [])[0] || '?';
      const cust = (body.match(/CUSTOMER:\\s*\\n?\\s*(.+)/) || [])[1] || '?';
      return { no, chips: Array.from(new Set(chips)), actions: Array.from(new Set(actions)), cust: cust.trim() };
    })()`)) as { no: string; chips: string[]; actions: string[]; cust: string };
    const approved = info.chips.includes('APPROVED*') || !info.actions.some((a) => /^approve$/i.test(a));
    console.log(`${info.no} ${approved ? '✓ APPROVED' : '✗ MASIH DRAFT'} — chips=[${info.chips.join(' ')}] aksi=[${info.actions.join(' ')}] customer=${info.cust}`);
  }
  await s.dispose();
  await close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
