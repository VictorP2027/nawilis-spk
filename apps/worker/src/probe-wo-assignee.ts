import { connect, close } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/** Open the WO create form and dump the Services-row controls (no save). */
async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const s = new TurbolySession({ baseUrl: config.turbolyBaseUrl, stateDir: config.turbolyStateDir, userAgentSuffix: config.userAgentSuffix, branchCode: 'NWL-BKS' });
  await s.start(); await s.ensureLoggedIn();
  const page = s.page_();
  await page.goto(process.argv[2]!, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(`(() => {
    const a = Array.from(document.querySelectorAll('a, button')).find((n) => /create\\s*(service\\s*)?work\\s*order/i.test(n.innerText || ''));
    if (a) a.click();
  })()`);
  await page.waitForTimeout(4000);
  const dump = (await page.evaluate(`(() => {
    var out = { url: location.href, headers: [], rowControls: [], select2: [] };
    var tables = Array.prototype.slice.call(document.querySelectorAll('table'));
    for (var t of tables) {
      var head = (t.querySelector('thead') || {}).innerText || '';
      if (!/assignee/i.test(head)) continue;
      out.headers.push(head.replace(/\\s+/g, ' ').trim());
      var rows = t.querySelectorAll('tbody tr');
      for (var r of Array.prototype.slice.call(rows)) {
        for (var c of Array.prototype.slice.call(r.querySelectorAll('input, select, textarea, a, div'))) {
          var cls = (c.className || '').toString();
          if (!/select2|assignee|form-control|text/i.test(cls) && !c.name && !c.id) continue;
          out.rowControls.push(c.tagName.toLowerCase() + '#' + (c.id || '-') + '[name=' + (c.name || '-') + '][class=' + cls.slice(0, 60) + ']');
        }
      }
    }
    for (var s2 of Array.prototype.slice.call(document.querySelectorAll('.select2-container'))) {
      out.select2.push('#' + (s2.id || '-') + ' class=' + (s2.className || '').slice(0, 70));
    }
    return out;
  })()`)) as Record<string, unknown>;
  console.log(JSON.stringify(dump, null, 1).slice(0, 2500));
  await s.dispose(); await close(); process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
