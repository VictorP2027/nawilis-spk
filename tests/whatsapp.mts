/**
 * Unit tests for the WhatsApp alert path, ported from the Check & Go
 * prototype's test/whatsapp.test.js.
 *
 * NOTHING here touches the network or Mongo: every client is constructed with
 * an injected fetch, and the message builder is pure. The assertions are
 * deliberately about BYTES (url, header, body) rather than about "it resolved",
 * because the wire format is the compatibility promise — an operator's approved
 * Meta template and paired WAHA session have to keep working across this port.
 *
 * Run: npx tsx tests/whatsapp.mts
 */
import {
  WhatsAppClient, TwilioWhatsAppClient, WahaWhatsAppClient, createWhatsAppClient,
  type AlertFetch, type AlertFetchResponse, type WhatsAppAlert,
} from '../packages/core/src/whatsapp.ts';
import { buildCheckGoAlert } from '../packages/core/src/checkgoAlert.ts';
import { DataError, TransientError } from '../packages/core/src/failure.ts';
import type { SpkDoc } from '../packages/core/src/types.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function section(s: string): void { console.log(`\n── ${s} ──`); }

/**
 * The only Response surface the clients may use. Anything they touch that is
 * not here (text(), Headers iteration) breaks this double and fails loudly.
 */
function fakeResponse(status: number, body: unknown, contentType = 'application/json'): AlertFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    async json() { return body; },
    async arrayBuffer() {
      const b = Buffer.from(String(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}

/** Injected where the code under test must decide BEFORE it reaches the wire. */
const noFetch: AlertFetch = async (url) => { throw new Error(`unexpected network call to ${url}`); };

async function caught(fn: () => Promise<unknown>): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return e as Error; }
}

/** Same fixture identity as the prototype's tests, so the bytes stay comparable. */
const ALERT: WhatsAppAlert = {
  to: '14047034284',
  text: '*HASIL CHECK & GO NAWILIS*\n\nHalo Jacob, berikut hasil pemeriksaan kendaraan Anda.',
  templateParams: ['Jacob', 'B 1234 XYZ', 'Balancing', '31 Juli 2026', 'Nawilis Bekasi'],
};

/**
 * Only the fields buildCheckGoAlert reads. Cast because a real SpkDoc carries
 * ~30 more that this unit deliberately does not touch.
 */
function checkGoDoc(over: Record<string, unknown> = {}): SpkDoc {
  return {
    _id: 'spk_test',
    branchCode: 'NWL-BKS',
    customer: { nama: 'Budi Santoso', waE164: '+6281234567890' },
    vehicle: {
      noPolisi: { full: 'B1743BKA', display: 'B 1743 BKA' },
      merkNormalized: 'TOYOTA', merkRaw: 'toyota', tipeNormalized: 'Avanza',
      km: { raw: '45.230', value: 45230 },
    },
    capture: { businessDate: '2026-08-05' },
    signatures: { menerima: { present: true, namaJelas: 'Rina S' } },
    checkGo: {
      harga: 150000,
      mechanicName: 'Andi',
      inspectionItems: [
        row('1. Cooling System', 'Pass', 'Pass · Air Radiator 1 L'),
        row('2. Brake System', 'Fail', 'Fail · Ketebalan Kampas Rem Depan 2 mm'),
        row('5. Electrical System', 'REPLACE (ganti)', 'REPLACE (ganti)'),
        row('6. Tire — Depan Kiri', null, 'Bridgestone · Tekanan Angin 30 · Aus tidak rata'),
        row('Rekomendasi untuk Ban', null, 'Spooring · Balancing'),
        row('Rekomendasi untuk 1 - 5', null, 'Kuras Cairan Rem'),
      ],
      report: {
        sections: [], electrical: 'REPLACE', rekomendasi: [], lainLain: null,
        tires: [{ position: 'DEPAN_KIRI', merk: 'Bridgestone', tekanan: '30', flags: [{ code: 'AUS_TIDAK_RATA', choice: null }] }],
      },
    },
    ...over,
  } as unknown as SpkDoc;
}

function row(item: string, hasil: string | null, catatan: string | null): unknown {
  return { item, hasil, catatan, feedback: null, recommendation: null, inspected: true };
}

async function main(): Promise<void> {
  section('META — WhatsApp Cloud API');
  {
    let request: { url: string; init?: Parameters<AlertFetch>[1] } | null = null;
    const client = new WhatsAppClient({
      accessToken: 'test-token', phoneNumberId: '123456789', apiVersion: 'v23.0',
      reportTemplate: 'check_go_report', reminderTemplate: 'check_go_reminder', templateLanguage: 'en',
    }, async (url, init) => {
      request = { url, init };
      return fakeResponse(200, { messages: [{ id: 'wamid.direct' }] });
    });

    const result = await client.sendReport(ALERT);
    const req = request as unknown as { url: string; init: { headers: Record<string, string>; body: string; method: string } };
    const payload = JSON.parse(req.init.body);
    ok(result.mode === 'live', 'live delivery reports mode "live"');
    ok(result.providerMessageId === 'wamid.direct', 'provider message id comes from messages[0].id, not a fresh UUID');
    ok(result.whatsappUrl === null, 'a live send has no click-to-chat URL');
    ok(req.url === 'https://graph.facebook.com/v23.0/123456789/messages', `graph URL carries the version and phone id (${req.url})`);
    ok(req.init.headers.Authorization === 'Bearer test-token', 'bearer token header');
    ok(payload.to === '14047034284', 'to is bare digits — no "+"');
    ok(payload.type === 'template' && payload.template.name === 'check_go_report', 'a configured report template wins over free text');
    ok(payload.template.language.code === 'en', 'template language is the configured code');
    ok(JSON.stringify(payload.template.components[0].parameters[1]) === '{"type":"text","text":"B 1234 XYZ"}', 'body params are positional {type,text}');
    ok(payload.recipient_type === undefined, 'the template payload carries NO recipient_type');
  }
  {
    let body = '';
    const client = new WhatsAppClient(
      { accessToken: 't', phoneNumberId: '1', apiVersion: 'v23.0' },
      async (_url, init) => { body = init?.body ?? ''; return fakeResponse(200, {}); },
    );
    const result = await client.sendReport(ALERT);
    const payload = JSON.parse(body);
    ok(payload.type === 'text' && payload.text.body === ALERT.text, 'without a report template the initial send is free text');
    ok(payload.recipient_type === 'individual', 'the text payload DOES carry recipient_type');
    ok(payload.text.preview_url === true, 'link preview stays on');
    ok(typeof result.providerMessageId === 'string' && result.providerMessageId.length > 0, 'a response without an id still yields an id');
  }
  {
    const client = new WhatsAppClient({}, noFetch);
    const result = await client.sendReport(ALERT);
    ok(result.mode === 'manual' && result.providerMessageId === null, 'unconfigured Meta sends nothing');
    ok(result.whatsappUrl === `https://wa.me/14047034284?text=${encodeURIComponent(ALERT.text)}`, 'it hands back a wa.me link with the message pre-filled');
    ok(client.status().mode === 'preview' && client.status().provider === 'meta', 'status() is preview and synchronous');

    const reminder = await client.sendReminder(ALERT);
    ok(reminder.skipped === true && reminder.reason === 'WhatsApp preview mode', 'a preview-mode reminder is skipped, not failed');
  }
  {
    const client = new WhatsAppClient({ accessToken: 't', phoneNumberId: '1' }, noFetch);
    const err = await caught(() => client.sendReminder(ALERT));
    ok(err?.name === 'DataError', `a missing reminder template is a DataError (got ${err?.name})`);
    ok(/WHATSAPP_REMINDER_TEMPLATE/.test(err?.message ?? ''), 'the error names the env var');
    ok(!/unexpected network call/.test(err?.message ?? ''), 'and it is decided before any network call');
  }
  {
    const cfg = { accessToken: 't', phoneNumberId: '1', apiVersion: 'v23.0' };
    const e500 = await caught(() => new WhatsAppClient(cfg, async () => fakeResponse(503, {})).sendReport(ALERT));
    ok(e500 instanceof TransientError, `HTTP 503 is transient (got ${e500?.name})`);
    ok(e500?.message === 'WhatsApp API returned HTTP 503', `an unparseable error body degrades to the status (${e500?.message})`);

    const e400 = await caught(() => new WhatsAppClient(cfg, async () => fakeResponse(400, { error: { message: 'Template name does not exist' } })).sendReport(ALERT));
    ok(e400 instanceof DataError, `HTTP 400 is a data failure (got ${e400?.name})`);
    ok(e400?.message === 'Template name does not exist', 'the provider message is surfaced verbatim');

    const e429 = await caught(() => new WhatsAppClient(cfg, async () => fakeResponse(429, {})).sendReport(ALERT));
    ok(e429 instanceof TransientError, 'HTTP 429 is transient');

    const down = await caught(() => new WhatsAppClient(cfg, async () => { throw new Error('ECONNREFUSED'); }).sendReport(ALERT));
    ok(down instanceof TransientError, `a transport failure is transient (got ${down?.name})`);
  }

  section('TWILIO');
  {
    let request: { url: string; init?: Parameters<AlertFetch>[1] } | null = null;
    const client = new TwilioWhatsAppClient({
      twilioAccountSid: 'AC123456', twilioAuthToken: 'test-token', twilioFromNumber: '+14155238886',
      twilioReportContentSid: '', twilioReminderContentSid: '',
    }, async (url, init) => { request = { url, init }; return fakeResponse(200, { sid: 'SM.direct' }); });

    const result = await client.sendReport(ALERT);
    const req = request as unknown as { url: string; init: { headers: Record<string, string>; body: string } };
    const payload = new URLSearchParams(req.init.body);
    ok(result.mode === 'live' && result.providerMessageId === 'SM.direct', 'provider message id comes from result.sid');
    ok(result.whatsappUrl === null, 'a live send has no click-to-chat URL');
    ok(/Accounts\/AC123456\/Messages\.json$/.test(req.url), `messages endpoint carries the SID (${req.url})`);
    ok(/^Basic /.test(req.init.headers.Authorization ?? ''), 'basic auth header');
    ok(payload.get('To') === 'whatsapp:+14047034284', 'To is prefixed and E.164 — Twilio wants the "+"');
    ok(payload.get('From') === 'whatsapp:+14155238886', 'From is the Sandbox number');
    ok(payload.get('Body') === ALERT.text, 'with no Content SID the Sandbox sends free text');
    ok(client.status().sandbox === true && client.status().reportTemplateConfigured === true, 'Sandbox counts as report-capable without a Content SID');
  }
  {
    let body = '';
    const client = new TwilioWhatsAppClient({
      twilioAccountSid: 'AC1', twilioAuthToken: 't', twilioFromNumber: '+628111111111',
      twilioReportContentSid: 'HXreport',
    }, async (_url, init) => { body = init?.body ?? ''; return fakeResponse(201, { sid: 'SM.2' }); });
    await client.sendReport(ALERT);
    const payload = new URLSearchParams(body);
    ok(payload.get('ContentSid') === 'HXreport', 'a configured Content SID is used');
    ok(payload.get('ContentVariables') === '{"1":"Jacob","2":"B 1234 XYZ","3":"Balancing","4":"31 Juli 2026","5":"Nawilis Bekasi"}',
      `template params become ContentVariables 1..5 (${payload.get('ContentVariables')})`);
    ok(client.status().sandbox === false, 'a real sender number is not the Sandbox');
  }
  {
    const client = createWhatsAppClient({ provider: 'twilio' }, noFetch);
    ok(client instanceof TwilioWhatsAppClient, 'the factory selects Twilio from config.provider');
    const status = client.status();
    ok(!(status instanceof Promise) && status.provider === 'twilio', 'Twilio status() is synchronous and safe on an empty config');
  }
  {
    const client = new TwilioWhatsAppClient({
      twilioAccountSid: 'AC123456', twilioAuthToken: 'test-token', twilioFromNumber: '+14155238886',
      twilioReminderContentSid: '',
    }, noFetch);
    const err = await caught(() => client.sendReminder(ALERT));
    ok(err?.name === 'DataError', `a missing reminder Content SID is a DataError (got ${err?.name})`);
    ok(/TWILIO_REMINDER_CONTENT_SID/.test(err?.message ?? ''), 'the error names the env var, before any network call');
  }
  {
    // The deliberate deviation from the prototype's normalizeE164, which turned
    // a stored local number into the unroutable "+081234567890".
    let body = '';
    const client = new TwilioWhatsAppClient(
      { twilioAccountSid: 'AC1', twilioAuthToken: 't', twilioFromNumber: '+14155238886' },
      async (_url, init) => { body = init?.body ?? ''; return fakeResponse(200, { sid: 'SM.3' }); },
    );
    await client.sendReport({ ...ALERT, to: '081234567890' });
    ok(new URLSearchParams(body).get('To') === 'whatsapp:+6281234567890', `a leading 0 is resolved to +62 (${new URLSearchParams(body).get('To')})`);
  }

  section('WAHA — local QR gateway');
  {
    let sent: { session: string; chatId: string; text: string } | null = null;
    let apiKey = '';
    const client = new WahaWhatsAppClient({
      wahaBaseUrl: 'http://127.0.0.1:3000', wahaApiKey: 'local-key', wahaSession: 'default',
    }, async (url, init) => {
      if (url.endsWith('/api/sessions/default')) return fakeResponse(200, { name: 'default', status: 'WORKING' });
      if (url.endsWith('/api/sendText')) {
        sent = JSON.parse(init?.body ?? '{}');
        apiKey = init?.headers?.['X-Api-Key'] ?? '';
        return fakeResponse(201, { id: 'waha.direct' });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await client.sendReport(ALERT);
    const payload = sent as unknown as { session: string; chatId: string; text: string };
    ok(result.mode === 'live' && result.providerMessageId === 'waha.direct', 'HTTP 201 counts as sent and the id comes from result.id');
    ok(result.whatsappUrl === null, 'a live send has no click-to-chat URL');
    ok(apiKey === 'local-key', 'the API key rides on every request as X-Api-Key');
    ok(payload.session === 'default', 'the session name is in the body');
    ok(payload.chatId === '14047034284@c.us', `chatId is bare digits + @c.us (${payload.chatId})`);
    ok(payload.text === ALERT.text, 'WAHA has no templates: it always sends the rendered text');
  }
  {
    const requests: Array<{ url: string; body: string }> = [];
    const client = new WahaWhatsAppClient({
      wahaBaseUrl: 'http://127.0.0.1:3000', wahaApiKey: 'local-key', wahaSession: 'default',
    }, async (url, init) => {
      requests.push({ url, body: init?.body ?? '' });
      if (url.endsWith('/api/sessions/default')) return fakeResponse(404, { message: 'Not found' });
      if (url.endsWith('/api/sessions')) return fakeResponse(201, { name: 'default', status: 'SCAN_QR_CODE' });
      if (url.endsWith('/api/default/auth/qr')) return fakeResponse(200, { mimetype: 'image/png', data: 'aGVsbG8=' });
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await client.qrCode();
    ok(result.dataUrl === 'data:image/png;base64,aGVsbG8=', `the JSON QR branch composes a data: URL (${result.dataUrl})`);
    ok(requests.length === 3, `probe, create, qr — exactly three requests (got ${requests.length})`);
    ok(JSON.parse(requests[1]?.body ?? '{}').name === 'default', 'a 404 probe is swallowed and the session is created');
    ok(requests[2]?.url === 'http://127.0.0.1:3000/api/default/auth/qr', `the QR path is /api/<session>/auth/qr (${requests[2]?.url})`);
    ok(!result.dataUrl.includes('local-key'), 'the API key never leaks into the data URL');
  }
  {
    const client = new WahaWhatsAppClient({ wahaSession: 'default' }, async (url) => {
      if (url.endsWith('/api/sessions/default')) return fakeResponse(200, { status: 'SCAN_QR_CODE' });
      throw new Error(`Unexpected URL ${url}`);
    });
    const result = await client.sendReport(ALERT);
    ok(result.mode === 'manual' && result.whatsappUrl !== null, 'an unpaired session falls back to the manual link instead of failing');
    const reminder = await client.sendReminder(ALERT);
    ok(reminder.skipped === true && reminder.reason === 'WAHA session is not connected', 'the reminder reason names WAHA, so the job can stay scheduled');
    const status = await client.status();
    ok(status.qrRequired === true, 'SCAN_QR_CODE asks the operator for a QR scan');
  }
  {
    const client = new WahaWhatsAppClient({ wahaSession: 'default' }, async () => { throw new Error('ECONNREFUSED'); });
    const status = await client.status();
    ok(status.sessionStatus === 'UNREACHABLE' && status.mode === 'preview', 'a dead container is a reported state, not a throw');
    ok((status.error ?? '').includes('ECONNREFUSED'), 'and the transport error is kept for the console');
  }
  {
    ok(createWhatsAppClient({ provider: 'waha' }, noFetch) instanceof WahaWhatsAppClient, 'the factory selects WAHA');
    ok(createWhatsAppClient({ provider: '' }, noFetch) instanceof WhatsAppClient, 'an empty provider falls back to Meta, never to an error');
    ok(createWhatsAppClient({ provider: 'nonsense' }, noFetch) instanceof WhatsAppClient, 'so does an unrecognised one');
  }

  section('CHECK & GO MESSAGE (pure)');
  {
    const alert = buildCheckGoAlert(checkGoDoc());
    const text = alert.text;
    ok(alert.to === '6281234567890', `to is bare digits from waE164 (${alert.to})`);
    ok(text.startsWith('*HASIL CHECK & GO NAWILIS*'), 'it identifies itself first — the customer has not saved this number');
    ok(text.includes('Halo Budi Santoso, berikut hasil pemeriksaan kendaraan Anda.'), 'greeting names the customer');
    ok(text.includes('Kendaraan: B 1743 BKA — TOYOTA Avanza'), 'the car is named by plate and model');
    ok(text.includes('Kilometer: 45.230 km'), `odometer keeps id-ID thousands separators (${text.match(/Kilometer: .*/)?.[0]})`);
    ok(text.includes('Cabang: Nawilis Bekasi'), 'the branch is resolved from the code');
    ok(text.includes('Tanggal pemeriksaan: 5 Agustus 2026'), `the date is Jakarta, in Indonesian (${text.match(/Tanggal pemeriksaan: .*/)?.[0]})`);
    ok(text.includes('Diperiksa oleh: Andi'), 'the checker is named');
    ok(text.includes('• 2. Brake System — perlu perbaikan (Ketebalan Kampas Rem Depan 2 mm)'),
      `a Fail becomes Indonesian with its reading (${text.match(/• 2\..*/)?.[0]})`);
    ok(text.includes('• 5. Electrical System — perlu diganti'), 'REPLACE becomes "perlu diganti" and does not repeat itself');
    ok(text.includes('• Ban depan kiri — aus tidak rata'), `tyre marks are named per wheel (${text.match(/• Ban.*/)?.[0]})`);
    ok(!text.includes('• 1. Cooling System'), 'a Pass is never listed as a finding');
    ok(text.includes('1 item lain diperiksa dan dalam kondisi baik.'), `the rest is a count, not a wall of "Pass" (${text.match(/\d+ item lain.*/)?.[0]})`);
    ok(text.includes('*Rekomendasi kami:*\n• Spooring\n• Balancing\n• Kuras Cairan Rem'), 'recommendations are flattened into one list');
    ok(text.includes('Rekomendasi di atas belum kami kerjakan.'), 'it states the recommendations are not done yet');
    ok(text.trim().endsWith('Balas pesan ini untuk mengatur jadwal servis.'), 'and ends with exactly one call to action');
    ok(JSON.stringify(alert.templateParams) === JSON.stringify(['Budi Santoso', 'B 1743 BKA', 'Spooring, Balancing, Kuras Cairan Rem', '5 Agustus 2026', 'Nawilis Bekasi']),
      `template params 1..5 (${JSON.stringify(alert.templateParams)})`);
  }
  {
    const alert = buildCheckGoAlert(checkGoDoc(), { reminder: true });
    ok(alert.text.startsWith('*PENGINGAT SERVIS NAWILIS*'), 'the reminder retitles the same alert');
    ok(alert.text.includes('ini pengingat untuk rekomendasi hasil Check & Go kendaraan B 1743 BKA'), 'and opens on the follow-up, not on "here are your results"');
    ok(alert.text.includes('• Spooring'), 'while keeping the findings and recommendations');
  }
  {
    const clean = checkGoDoc({
      checkGo: {
        harga: 150000, mechanicName: null,
        inspectionItems: [row('1. Cooling System', 'Pass', 'Pass'), row('2. Brake System', 'Pass', 'Pass')],
        report: null,
      },
    });
    const text = buildCheckGoAlert(clean).text;
    ok(text.includes('Semua 2 item yang diperiksa dalam kondisi baik.'), `a clean check says so plainly (${text.match(/Semua.*/)?.[0]})`);
    ok(!text.includes('Perlu perhatian'), 'and shows no findings heading');
    ok(text.trim().endsWith('Balas pesan ini bila ada yang ingin ditanyakan.'), 'with no recommendations, the closing does not promise a job');
  }
  {
    const err = await caught(async () => buildCheckGoAlert(checkGoDoc({ customer: { nama: 'X', waE164: '0812' } })));
    ok(err instanceof DataError, `an unreachable number is a DataError, never a retry (got ${err?.name})`);
    const missing = await caught(async () => buildCheckGoAlert(checkGoDoc({ checkGo: undefined })));
    ok(missing instanceof DataError, 'so is an SPK with no Check & Go data');
  }
  {
    const feedbackDoc = checkGoDoc({
      checkGo: {
        harga: 0, mechanicName: null, report: null,
        inspectionItems: [{ item: 'Kaki-kaki', hasil: 'Pass', catatan: null, feedback: 'fail', recommendation: null, inspected: true }],
      },
    });
    ok(buildCheckGoAlert(feedbackDoc).text.includes('• Kaki-kaki — perlu perbaikan'), "the mechanic's feedback overrides the checker's Pass");
  }
  {
    const unknownVerdict = checkGoDoc({
      checkGo: {
        harga: 0, mechanicName: null, report: null,
        inspectionItems: [row('Sesuatu Yang Baru', 'Belum Dicek', 'catatan')],
      },
    });
    ok(!buildCheckGoAlert(unknownVerdict).text.includes('Perlu perhatian'), 'an unrecognised verdict reads as "checked", never as an alarm');
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
