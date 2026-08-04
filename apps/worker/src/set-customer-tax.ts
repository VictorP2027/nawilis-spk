import { connect, close } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * Backfill "* SALES TAX" = PPN on customers that were saved before the form
 * bug was fixed (a select2 the automation could not actually drive, whose
 * failure was swallowed — those records saved with an EMPTY sales tax).
 *
 *   node --import tsx apps/worker/src/set-customer-tax.ts --ids=4872592,4872589 [--wholesale=1] [--check]
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const has = (k: string): boolean => process.argv.includes(`--${k}`);

const SET_PPN = `(() => {
  const sels = ['#customer_service_tax_id', '#customer_tax_id'].map((q) => document.querySelector(q)).filter(Boolean);
  const sel = sels.find((s) => Array.from(s.options).some((o) => /^ppn$/i.test((o.textContent || '').trim()))) || sels[0];
  if (!sel) return { ok: false, why: 'kontrol tidak ada', current: null };
  const cur = sel.options[sel.selectedIndex];
  const curText = ((cur && cur.textContent) || '').trim();
  const want = Array.from(sel.options).find((o) => /^ppn$/i.test((o.textContent || '').trim()));
  if (!want) return { ok: false, why: 'PPN tidak ada di daftar', current: curText };
  sel.value = want.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  try { if (window.jQuery) window.jQuery(sel).val(want.value).trigger('change'); } catch (e) { /* widget sync only */ }
  const now = sel.options[sel.selectedIndex];
  return { ok: /^ppn$/i.test(((now && now.textContent) || '').trim()), why: 'read-back', current: curText };
})()`;

const READ = `(() => {
  const sels = ['#customer_service_tax_id', '#customer_tax_id'].map((q) => document.querySelector(q)).filter(Boolean);
  const sel = sels.find((s) => Array.from(s.options).some((o) => /^ppn$/i.test((o.textContent || '').trim()))) || sels[0];
  if (!sel) return '(kontrol tidak ada)';
  const cur = sel.options[sel.selectedIndex];
  return ((cur && cur.textContent) || '').trim() || '(kosong)';
})()`;

async function main(): Promise<void> {
  const ids = (arg('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('--ids=4872592,… wajib');
  const wholesale = arg('wholesale') === '1';
  const checkOnly = has('check');
  await connect(config.mongoUri, config.mongoDb);
  const s = new TurbolySession({
    baseUrl: config.turbolyBaseUrl,
    stateDir: config.turbolyStateDir,
    userAgentSuffix: config.userAgentSuffix,
    branchCode: arg('branch') ?? 'NWL-BKS',
  });
  await s.start();
  await s.ensureLoggedIn();
  const page = s.page_();

  for (const id of ids) {
    const url = `${config.turbolyBaseUrl}/customers/${id}/edit${wholesale ? '?wholesale=1' : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    if (checkOnly) {
      console.log(`${id}: SALES TAX = ${await page.evaluate(READ)}`);
      continue;
    }
    const r = (await page.evaluate(SET_PPN)) as { ok: boolean; why: string; current: string | null };
    if (!r.ok) {
      console.error(`${id}: ✗ tidak bisa set PPN (${r.why}, sekarang="${r.current ?? '?'}")`);
      continue;
    }
    // The main-address radio is not re-posted by the edit form unless it is
    // still selected — tick it so the save can't fail with "Main Address must be one".
    await page.evaluate(`(() => {
      const radios = Array.from(document.querySelectorAll('input[type=radio]')).filter((x) => /main_address/i.test(x.name || x.id || ''));
      if (radios.length && !radios.some((x) => x.checked)) radios[0].click();
    })()`);
    await page.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('a, button, input[type=submit]')).find((n) => /^(save|simpan)$/i.test(((n.innerText || n.value) || '').trim()));
      if (btn) btn.click();
    })()`);
    await page.waitForTimeout(3500);
    await page.waitForLoadState('networkidle').catch(() => {});
    const err = (await page.evaluate(`(() => {
      const e = document.querySelector('.alert-error, .alert-danger, .error-message');
      return e ? (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
    })()`)) as string | null;
    // Independent read-back on a fresh load — the flash alone is not proof.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const after = await page.evaluate(READ);
    console.log(`${id}: ${/^ppn$/i.test(String(after)) ? '✓' : '✗'} SALES TAX = ${after}${err ? ` (error: ${err})` : ''}`);
  }

  await s.dispose();
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
