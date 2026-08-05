import { connect, close } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';
async function main(): Promise<void> {
  await connect(config.mongoUri, config.mongoDb);
  const s = new TurbolySession({ baseUrl: config.turbolyBaseUrl, stateDir: config.turbolyStateDir, userAgentSuffix: config.userAgentSuffix, branchCode: 'NWL-BKS' });
  await s.start(); await s.ensureLoggedIn();
  const page = s.page_();
  const wo = process.argv[2]!, line = process.argv[3]!;
  await page.goto(wo, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const out = await page.evaluate(`(async () => {
    var token = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
    var base = location.origin + location.pathname.replace(/\\/$/, '');
    var names = ['end_progress_service_item','stop_progress_service_item','finish_progress_service_item','pause_progress_service_item','complete_service_item','completed_service_item'];
    var res = [];
    for (var n of names) {
      var url = base + '/' + n + '?additional_line_id=${line}';
      try {
        var r = await fetch(url, { method: 'PATCH', headers: { 'X-CSRF-Token': token, accept: 'text/html' }, redirect: 'manual' });
        res.push(n + ' -> ' + r.status + (r.headers.get('location') ? ' loc=' + r.headers.get('location') : ''));
        if (r.status < 400) break;
      } catch (e) { res.push(n + ' -> threw'); }
    }
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 1));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const status = await page.evaluate(`(() => (document.body.innerText.match(/WAITING FOR QC|IN PROGRESS|COMPLETED/g) || []).join(','))()`);
  console.log('status text seen:', status);
  await s.dispose(); await close(); process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
