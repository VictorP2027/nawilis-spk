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
  const out = (await page.evaluate(`(() => {
    var res = { headers: [], cells: [] };
    for (var t of Array.prototype.slice.call(document.querySelectorAll('table'))) {
      var head = ((t.querySelector('thead') || {}).innerText || '').replace(/\\s+/g, ' ').trim();
      if (!/progress|completed/i.test(head)) continue;
      res.headers.push(head);
      for (var r of Array.prototype.slice.call(t.querySelectorAll('tbody tr'))) {
        var tds = Array.prototype.slice.call(r.querySelectorAll('td'));
        tds.forEach(function (td, i) {
          for (var el of Array.prototype.slice.call(td.querySelectorAll('a, button, i, span, input'))) {
            var d = {};
            for (var a of Array.prototype.slice.call(el.attributes)) d[a.name] = a.value.slice(0, 80);
            res.cells.push({ col: i, tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 20), attrs: d });
          }
        });
      }
    }
    return res;
  })()`)) as Record<string, unknown>;
  console.log(JSON.stringify(out, null, 1).slice(0, 3000));
  await s.dispose(); await close(); process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
