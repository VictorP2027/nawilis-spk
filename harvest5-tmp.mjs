import { connect, close, getDb } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';
import { TurbolySession } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/turboly/index.js';
import fs from 'node:fs';
const base = process.env.TURBOLY_BASE_URL || 'https://sandbox.turboly.com';
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const s = new TurbolySession({ baseUrl: base, stateDir: './.turboly-state', userAgentSuffix: 'harvest', branchCode: 'NWL-BKS' });
await s.start(); await s.ensureLoggedIn();
const page = s.page_();
await page.goto(`${base}/vehicles/new`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const makes = await page.$$eval('#vehicle-make-select option', (o) => o.map((e) => (e.textContent || '').trim()).filter(Boolean));
console.log('makes:', makes.length);
const byMake = {};
let done = 0;
for (const name of makes) {
  try {
    await page.locator('#s2id_vehicle-make-select .select2-choice').click({ timeout: 5000 });
    await page.waitForTimeout(250);
    await page.locator('.select2-drop input.select2-input').last().fill(name);
    await page.waitForTimeout(600);
    await page.locator('.select2-drop .select2-results li.select2-result-selectable').first().click({ timeout: 4000 });
    await page.waitForTimeout(500);
    await page.locator('#s2id_vehicle-model-select .select2-choice').click({ timeout: 4000 });
    // poll until the remote list resolves (not "Searching...")
    let items = [];
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => {
        const lis = Array.from(document.querySelectorAll('.select2-drop .select2-results li'));
        return { texts: lis.map((l) => l.innerText.trim()), searching: lis.some((l) => l.classList.contains('select2-searching')) };
      });
      if (!st.searching && st.texts.length) { items = st.texts; break; }
    }
    byMake[name] = [...new Set(items.filter((t) => t && !/searching|no matches|more characters/i.test(t)))].sort();
    await page.keyboard.press('Escape').catch(() => {});
  } catch { byMake[name] = []; }
  done++;
  if (done % 15 === 0) console.log(`…${done}/${makes.length} (models so far: ${Object.values(byMake).reduce((a, b) => a + b.length, 0)})`);
}
const total = Object.values(byMake).reduce((a, b) => a + b.length, 0);
fs.writeFileSync('data/turboly-vehicle-models.json', JSON.stringify(byMake, null, 2));
const col = getDb().collection('vehicle_models_map');
await col.deleteMany({});
await col.insertOne({ _id: 'byMake', byMake, syncedAt: new Date().toISOString() });
console.log('DONE. makes:', Object.keys(byMake).length, '| total models:', total);
console.log('GWM:', JSON.stringify((byMake['GWM'] ?? []).slice(0, 10)));
console.log('FERRARI:', JSON.stringify(byMake['FERRARI'] ?? []));
await s.dispose(); await close();
