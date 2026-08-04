import { connect, close, collections } from '@spk/core';
import { TurbolySession } from '@spk/core/turboly';
import { config } from './config.js';

/**
 * Adopt an ALREADY-CREATED Service Order back onto its SPK.
 *
 * When a push creates the order in Turboly but dies before Mongo records it,
 * the doc is left `failed` — and a retry would create a SECOND order. This
 * finds the real order by the SPK's reference token and attaches it, so the
 * pipeline resumes instead of duplicating.
 *
 *   node --import tsx apps/worker/src/recover-so.ts --id=01K… --customer=4872582
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function main(): Promise<void> {
  const spkId = arg('id');
  const customerId = arg('customer');
  if (!spkId) throw new Error('--id=<spkId> wajib');
  await connect(config.mongoUri, config.mongoDb);
  const doc = await collections.spk().findOne({ _id: spkId });
  if (!doc) throw new Error(`SPK ${spkId} tidak ada`);
  console.log(`recover: ${spkId} state=${doc.state} plate=${doc.vehicle.noPolisi.display}`);

  const s = new TurbolySession({
    baseUrl: config.turbolyBaseUrl,
    stateDir: config.turbolyStateDir,
    userAgentSuffix: config.userAgentSuffix,
    branchCode: doc.branchCode,
  });
  await s.start();
  await s.ensureLoggedIn();
  const page = s.page_();

  // Candidate order pages: everything the customer page links to (newest first).
  const source = customerId ? `${config.turbolyBaseUrl}/customers/${customerId}` : `${config.turbolyBaseUrl}/service_orders`;
  await page.goto(source, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const links = (await page.evaluate(`(() => {
    const ids = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const m = (a.getAttribute('href') || '').match(/\\/service_orders\\/(\\d+)/);
      if (m) ids.add(m[1]);
    }
    return Array.from(ids);
  })()`)) as string[];
  console.log(`recover: kandidat SO = ${links.join(', ') || '(kosong)'}`);

  const token = doc.push.correlationToken;
  let hit: { url: string; no: string } | null = null;
  for (const id of links.sort((a, b) => Number(b) - Number(a))) {
    const url = `${config.turbolyBaseUrl}/service_orders/${id}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    if (!body.includes(token) && !body.includes(spkId)) continue;
    const no = body.match(/\bSRO\/[A-Z0-9]{2,6}\/\d{4,}\b/)?.[0] ?? null;
    hit = { url: page.url(), no: no ?? '' };
    break;
  }
  await s.dispose().catch(() => {});

  if (!hit) {
    console.error('recover: tidak ada Service Order dengan token SPK ini — aman untuk push ulang');
    await close();
    process.exit(2);
  }
  const now = new Date().toISOString();
  await collections.spk().updateOne(
    { _id: spkId },
    {
      $set: {
        state: 'pushed',
        'turboly.serviceOrderNo': hit.no || null,
        'turboly.serviceOrderUrl': hit.url,
        'push.lastError': null,
        'push.failureClass': null,
        updatedAt: now,
      },
    },
  );
  console.log(`recover: ✓ ${spkId} → ${hit.no} ${hit.url} (state=pushed)`);
  await close();
  process.exit(0);
}
main().catch(async (e) => { console.error(e); await close().catch(() => {}); process.exit(1); });
