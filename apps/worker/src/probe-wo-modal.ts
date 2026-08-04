import { connect, close } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';
async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const s = new TurbolySession({ baseUrl: config.turbolyBaseUrl, stateDir: config.turbolyStateDir, userAgentSuffix: config.userAgentSuffix, branchCode: 'NWL-BKS' });
  await s.start(); await s.ensureLoggedIn();
  const page = s.page_();
  await page.goto(process.argv[2]!, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(`(() => {
    var a = Array.prototype.slice.call(document.querySelectorAll('td a')).find(function (x) {
      return x.querySelector('i.icon-time') || /icon-time/.test((x.innerHTML || ''));
    });
    if (a) a.click();
  })()`);
  await page.waitForTimeout(2500);
  const out = (await page.evaluate(`(() => {
    var res = [];
    for (var m of Array.prototype.slice.call(document.querySelectorAll('.modal, .modal-scrollable'))) {
      if (getComputedStyle(m).display === 'none') continue;
      var fields = Array.prototype.slice.call(m.querySelectorAll('input, select, textarea')).map(function (c) {
        return c.tagName.toLowerCase() + '#' + (c.id || '-') + '[name=' + (c.name || '-') + '][type=' + (c.type || '-') + ']';
      });
      var btns = Array.prototype.slice.call(m.querySelectorAll('a, button, input[type=submit]')).map(function (b) {
        return ((b.innerText || b.value || '').trim().slice(0, 24)) + (b.getAttribute('href') ? ' -> ' + b.getAttribute('href').slice(0, 70) : '');
      });
      res.push({ text: (m.innerText || '').replace(/\\s+/g, ' ').slice(0, 200), fields: fields, buttons: btns });
    }
    return res;
  })()`)) as unknown[];
  console.log(JSON.stringify(out, null, 1).slice(0, 2200));
  await s.dispose(); await close(); process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
