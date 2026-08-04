import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/** Throwaway discovery: dump the customer form's ADDRESS block structure. */
async function main(): Promise<void> {
  const s = new TurbolySession({
    baseUrl: config.turbolyBaseUrl,
    stateDir: config.turbolyStateDir,
    userAgentSuffix: config.userAgentSuffix,
    branchCode: 'NWL-BKS',
  });
  await s.start();
  await s.ensureLoggedIn();
  const page = s.page_();
  await page.goto(`${config.turbolyBaseUrl}/customers/new?wholesale=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const SNAP = `(() => {
    const out = { addr: [], modals: [], tables: [], addrSection: '', buttons: [] };
    for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const r = el.getBoundingClientRect();
      const v = r.width > 0 && r.height > 0 ? '' : '(hidden)';
      const desc = el.tagName.toLowerCase() + '#' + (el.id || '-') + '[name=' + (el.name || '-') + '][type=' + (el.type || '-') + ']' + v + (el.type === 'checkbox' ? '(checked=' + el.checked + ')' : '');
      if (/address|main|primary/i.test(desc)) out.addr.push(desc);
    }
    for (const m of Array.from(document.querySelectorAll('.modal, .modal-scrollable'))) {
      out.modals.push(m.className + ' display=' + getComputedStyle(m).display + ' text="' + (m.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) + '"');
    }
    for (const t of Array.from(document.querySelectorAll('table'))) {
      out.tables.push((t.innerText || '').replace(/\\s+/g, ' ').slice(0, 200));
    }
    for (const b of Array.from(document.querySelectorAll('a, button, input[type=button], input[type=submit]'))) {
      const t = (b.innerText || b.value || '').trim().replace(/\\s+/g, ' ');
      if (t && b.offsetParent !== null) out.buttons.push(t.slice(0, 40));
    }
    const anchor = document.querySelector('#address_address');
    const box = anchor ? anchor.closest('form, .modal, section, fieldset, div') : null;
    out.addrSection = box ? box.outerHTML.replace(/\\s+/g, ' ').slice(0, 3000) : '(no #address_address)';
    return out;
  })()`;

  const dump = async (tag: string) => {
    const info = (await page.evaluate(SNAP)) as Record<string, unknown>;
    console.log(`\n===== ${tag} =====`);
    console.log('address-ish fields:', JSON.stringify(info.addr));
    console.log('modals:', JSON.stringify(info.modals));
    console.log('tables:', JSON.stringify(info.tables));
    console.log('buttons:', JSON.stringify(info.buttons));
    console.log('address section HTML:\n', info.addrSection);
  };

  await dump('BEFORE Add Address');

  const clicked = await page.evaluate(`(() => {
    const hit = Array.from(document.querySelectorAll('a, button')).find((n) => /add\\s*address/i.test(n.innerText || '') && n.offsetParent !== null);
    if (!hit) return null;
    hit.click();
    return hit.outerHTML.replace(/\\s+/g, ' ').slice(0, 300);
  })()`);
  console.log('\nAdd Address control:', clicked);
  await page.waitForTimeout(2500);
  await dump('AFTER Add Address');

  await s.dispose();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
