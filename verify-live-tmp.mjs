import { chromium } from 'playwright';
const SP = '/private/tmp/claude-501/-Users-victorphisitkul-Desktop-untitled-folder-2/54f45b54-3edb-4c2a-9602-51e9ae13ae82/scratchpad';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
// staff login
await page.goto('https://nawilis-spk.vercel.app/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type=password]', 'nawilis2026');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
await page.goto('https://nawilis-spk.vercel.app/sheet', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
// count zones + click a wheel to prove selectability
const counts = await page.evaluate(() => ({
  zones: document.querySelectorAll('svg.car .zone').length,
  circles: document.querySelectorAll('svg.car circle.zone').length,
}));
console.log('live zones:', JSON.stringify(counts));
// click the front-left wheel circle
const wheel = page.locator('svg.car circle.zone').first();
await wheel.click({ force: true });
await page.waitForTimeout(400);
const after = await page.evaluate(() => document.querySelectorAll('svg.car .zone.on').length);
console.log('selected after wheel click:', after);
const car = page.locator('svg.car');
await car.screenshot({ path: `${SP}/live-diagram.png` });
await b.close();
