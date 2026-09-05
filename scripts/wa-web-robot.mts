/**
 * The no-Docker WhatsApp robot: a real browser, logged into plain
 * web.whatsapp.com, driven by Playwright — the same muscle that drives
 * Turboly. For machines where Docker was the barrier, this is the whole
 * stack: Node + this script.
 *
 *   npx tsx scripts/wa-web-robot.mts --login          # once: window opens, scan QR
 *   npx tsx scripts/wa-web-robot.mts --send           # drain the queue once
 *   npx tsx scripts/wa-web-robot.mts --send --watch   # keep draining (robot mode)
 *
 * Same contract as every other sender: ONLY documents staff stamped
 * 'requested' on the flow board are sent, delivered docs are stamped 'live'
 * and never sent twice, 25 per pass, a human pause between messages. The
 * browser profile (the WhatsApp login) lives in .wa-web-profile/ — gitignored,
 * pair once and it survives restarts, exactly like WhatsApp Web in a browser
 * you use daily.
 *
 * Honest caveats: this automates WhatsApp's own web UI, so it is as
 * unofficial as WAHA with MORE moving parts (their UI can change under us).
 * It exists for one reason — zero Docker — and inherits every safety rail.
 */
import { chromium } from 'playwright';
import { connect, close, collections, buildCheckGoAlert, branchRefFor } from '../packages/core/dist/index.js';

const LOGIN = process.argv.includes('--login');
const SEND = process.argv.includes('--send');
const WATCH = process.argv.some((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SECS = Math.max(15, Number(process.argv.find((a) => a.startsWith('--watch='))?.split('=')[1] ?? 30) || 30);
const PROFILE = new URL('../.wa-web-profile', import.meta.url).pathname;

const MAX_PER_RUN = 25;
const MAX_AGE_DAYS = 7;
const PAUSE_MS = 4_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function openBrowser(headed: boolean) {
  return chromium.launchPersistentContext(PROFILE, {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/** Send button in the composer — WhatsApp's UI, so match generously. */
const SEND_BTN = 'button[aria-label*="Send" i], button[aria-label*="Kirim" i], span[data-icon="send"], span[data-icon="wds-ic-send-filled"]';

async function loggedIn(page: import('playwright').Page): Promise<boolean> {
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' });
  // Chat list = in; QR canvas = out. Give the app time to boot either way.
  const winner = await Promise.race([
    page.waitForSelector('[aria-label*="Chat list" i], [data-testid="chat-list"], #pane-side', { timeout: 45_000 }).then(() => 'in'),
    page.waitForSelector('canvas', { timeout: 45_000 }).then(() => 'qr'),
  ]).catch(() => 'unknown');
  return winner === 'in';
}

if (LOGIN) {
  const ctx = await openBrowser(true);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const ok = await loggedIn(page);
  if (ok) {
    console.log('Sudah login — profil siap. Jalankan dengan --send --watch.');
  } else {
    console.log('Scan QR di jendela browser (WhatsApp → Perangkat tertaut). Menunggu…');
    await page.waitForSelector('#pane-side, [data-testid="chat-list"]', { timeout: 5 * 60_000 });
    console.log('✓ Ter-pairing. Profil tersimpan di .wa-web-profile/. Jendela boleh ditutup.');
  }
  await ctx.close();
  process.exit(0);
}

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');

async function stamp(spkId: string, alert: Record<string, unknown>) {
  await collections.spk()
    .updateOne({ _id: spkId }, { $set: { 'checkGo.alert': { ...alert, at: new Date().toISOString() } } })
    .catch(() => undefined);
}

async function drainOnce(): Promise<void> {
  const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString();
  const docs = await collections.spk()
    .find({ docType: 'CHECK_AND_GO', state: { $nin: ['voided', 'superseded'] }, createdAt: { $gte: since }, 'checkGo.alert.mode': 'requested' } as never)
    .sort({ createdAt: 1 })
    .limit(MAX_PER_RUN)
    .toArray();
  if (!docs.length) { if (!WATCH) console.log('antrean kosong'); return; }

  const ctx = await openBrowser(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    if (!(await loggedIn(page))) {
      console.error('BELUM LOGIN — jalankan dulu: npx tsx scripts/wa-web-robot.mts --login');
      return;
    }
    for (const doc of docs as never as Array<Record<string, never>>) {
      const d = doc as never as {
        _id: string;
        vehicle?: { noPolisi?: { display?: string } };
        checkGo?: { alert?: { by?: string; text?: string } };
      };
      // Queue-stamp fields that must survive the send: who approved, and any
      // edited wording — the edit is also what actually gets sent.
      const queued = d.checkGo?.alert ?? {};
      const editedText = typeof queued.text === 'string' && queued.text.trim() !== '' ? queued.text : null;
      const keep = {
        ...(queued.by ? { by: queued.by } : {}),
        ...(editedText ? { text: editedText } : {}),
      };
      let alert;
      try {
        alert = buildCheckGoAlert(doc as never, { branchName: (await branchRefFor(doc.branchCode))?.name ?? null });
        if (editedText) alert = { ...alert, text: editedText };
      } catch (e) {
        console.error(`  SKIP ${d._id} — ${(e as Error).message}`);
        if (SEND) await stamp(d._id, { mode: 'failed', error: String((e as Error).message).slice(0, 300), ...keep });
        continue;
      }
      if (!SEND) { console.log(`  would send → ${alert.to} (${d.vehicle?.noPolisi?.display ?? d._id})`); continue; }
      try {
        // wa.me deep link inside the logged-in app: opens the chat with the
        // message pre-filled; the robot presses the one button a human would.
        await page.goto(`https://web.whatsapp.com/send?phone=${alert.to}&text=${encodeURIComponent(alert.text)}`, { waitUntil: 'domcontentloaded' });
        const btn = page.locator(SEND_BTN).first();
        await btn.waitFor({ state: 'visible', timeout: 60_000 });
        await btn.click();
        // The composer emptying is the send confirmation this UI gives us.
        await page.waitForTimeout(2_500);
        await stamp(d._id, { mode: 'live', provider: 'wa-web-robot', to: alert.to, providerMessageId: null, ...keep });
        console.log(`  sent → ${alert.to} (${d.vehicle?.noPolisi?.display ?? d._id})`);
        await sleep(PAUSE_MS);
      } catch (e) {
        // Selector/UI failures leave the doc 'requested' — the next pass (or
        // another sender) retries; nothing is half-stamped.
        console.error(`  FAIL ${d._id} — ${(e as Error).message.slice(0, 120)} (tetap di antrean)`);
      }
    }
  } finally {
    await ctx.close();
  }
}

if (WATCH) {
  console.log(`wa-web-robot: watch tiap ${WATCH_SECS}s (profil: .wa-web-profile)`);
  for (;;) {
    try { await drainOnce(); } catch (e) { console.error(`pass crashed: ${(e as Error).message.slice(0, 100)}`); }
    await sleep(WATCH_SECS * 1000);
  }
} else {
  await drainOnce();
  await close();
  process.exit(0);
}
