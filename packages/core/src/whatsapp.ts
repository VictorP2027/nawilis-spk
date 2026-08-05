/**
 * WhatsApp delivery for customer-facing alerts.
 *
 * Ported from the Check & Go prototype's src/whatsapp.js. The bytes on the wire
 * are deliberately identical — same URLs, same header order, same JSON key
 * order, same env var names — so an operator's already-approved templates,
 * Twilio Content SIDs and scanned WAHA session keep working after the move.
 *
 * Three providers behind one contract, chosen by WHATSAPP_PROVIDER:
 *   waha   — free local QR gateway (a phone stays paired). Free text only.
 *   meta   — WhatsApp Cloud API. Approved template, or free text if none is set.
 *   twilio — Twilio. Content SID, or free text on the Sandbox number.
 * Anything unrecognised is Meta; that is the source's behaviour and an unknown
 * value must not silently stop alerts.
 *
 * Nothing here composes copy. A client takes an already-rendered WhatsAppAlert
 * (checkgoAlert.ts) so the message is testable without a network, and so a
 * change to the wording can never change the wire format.
 */
import { randomUUID } from 'node:crypto';
import { canonPhoneKey } from './indonesia.js';
import { DataError, TransientError } from './failure.js';

// ─────────────────────────────────────────────────────────────────────────
// Contracts
// ─────────────────────────────────────────────────────────────────────────

/**
 * One rendered message, ready to send. `text` and `templateParams` are two
 * renderings of the SAME alert: which one goes out depends on the provider and
 * on whether a template is configured, never on the caller.
 */
export interface WhatsAppAlert {
  /**
   * Wire address: digits only, country code included, NO '+'. This is what Meta
   * and wa.me take verbatim; Twilio and WAHA re-add the '+' themselves.
   */
  to: string;
  /** Fully rendered free-text body (WhatsApp markdown). */
  text: string;
  /** Positional body variables for an approved template, slot 1 first. */
  templateParams: readonly string[];
}

export interface SendResult {
  /** 'live' = it left the building. 'manual' = nothing was sent; use whatsappUrl. */
  mode: 'live' | 'manual';
  providerMessageId: string | null;
  /**
   * Click-to-chat deep link with the message pre-filled, non-null exactly when
   * mode is 'manual'. Staff send it by hand from their own WhatsApp — that is
   * the fallback when no provider is connected, not an error.
   */
  whatsappUrl: string | null;
  /** The rendered body, only on the manual path (so it can be shown/stored). */
  message?: string;
  response?: unknown;
  /** Reminder-only: the send was deliberately not attempted; stay scheduled. */
  skipped?: boolean;
  reason?: string;
}

export interface WhatsAppStatus {
  mode: 'live' | 'preview';
  provider: WhatsAppProvider;
  reportTemplateConfigured: boolean;
  reminderTemplateConfigured: boolean;
  /** Twilio only: the shared Sandbox number, which may send free text. */
  sandbox?: boolean;
  /** WAHA only. */
  session?: string;
  sessionStatus?: string;
  qrRequired?: boolean;
  error?: string | null;
}

export type WhatsAppProvider = 'meta' | 'twilio' | 'waha';

export interface WhatsAppSender {
  readonly provider: WhatsAppProvider;
  /**
   * Sync for Meta/Twilio (pure config), async for WAHA (it probes the gateway).
   * Callers must `await Promise.resolve(sender.status())`.
   */
  status(): WhatsAppStatus | Promise<WhatsAppStatus>;
  sendReport(alert: WhatsAppAlert): Promise<SendResult>;
  /** Pass an alert built with `{ reminder: true }` — the copy differs, the wire format does not. */
  sendReminder(alert: WhatsAppAlert): Promise<SendResult>;
}

export interface WhatsAppConfig {
  provider: string;
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  reportTemplate: string;
  reminderTemplate: string;
  templateLanguage: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
  twilioReportContentSid: string;
  twilioReminderContentSid: string;
  wahaBaseUrl: string;
  wahaApiKey: string;
  wahaSession: string;
}

/**
 * The only parts of a Response these clients may touch. Narrow on purpose: a
 * test double has to be able to stand in for one, and anything richer (text(),
 * Headers iteration) would make the doubles diverge from the real thing.
 */
export interface AlertFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AlertFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type AlertFetch = (url: string, init?: AlertFetchInit) => Promise<AlertFetchResponse>;

/** Partial so a caller (and a test) may set only the keys its provider reads. */
export type WhatsAppConfigInput = Partial<WhatsAppConfig>;

const TWILIO_SANDBOX_NUMBER = '+14155238886';

// ─────────────────────────────────────────────────────────────────────────
// Meta WhatsApp Cloud API
// ─────────────────────────────────────────────────────────────────────────

export class WhatsAppClient implements WhatsAppSender {
  readonly provider = 'meta' as const;
  private readonly config: WhatsAppConfigInput;
  private readonly fetch: AlertFetch;

  constructor(config: WhatsAppConfigInput, fetchImpl: AlertFetch = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  /** Templates are NOT part of liveness: without one we fall back to free text. */
  get live(): boolean {
    return Boolean(this.config.accessToken && this.config.phoneNumberId);
  }

  status(): WhatsAppStatus {
    return {
      mode: this.live ? 'live' : 'preview',
      provider: 'meta',
      reportTemplateConfigured: Boolean(this.config.reportTemplate),
      reminderTemplateConfigured: Boolean(this.config.reminderTemplate),
    };
  }

  async sendReport(alert: WhatsAppAlert): Promise<SendResult> {
    if (!this.live) return manualPreview(alert);
    if (this.config.reportTemplate) {
      return this.sendTemplate(alert.to, this.config.reportTemplate, alert.templateParams);
    }
    return this.sendText(alert.to, alert.text);
  }

  async sendReminder(alert: WhatsAppAlert): Promise<SendResult> {
    if (!this.live) return { ...manualPreview(alert), skipped: true, reason: 'WhatsApp preview mode' };
    // A follow-up lands outside the 24h customer-service window, where free text
    // is rejected. Refuse rather than burn an attempt on a guaranteed rejection.
    if (!this.config.reminderTemplate) {
      throw new DataError('WHATSAPP_REMINDER_TEMPLATE is required for automatic reminders.');
    }
    return this.sendTemplate(alert.to, this.config.reminderTemplate, alert.templateParams);
  }

  private async sendText(to: string, body: string): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: true, body },
    });
  }

  private async sendTemplate(to: string, templateName: string, parameters: readonly string[]): Promise<SendResult> {
    return this.post({
      // No recipient_type here — the template payload does not carry it.
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: this.config.templateLanguage },
        components: [{
          type: 'body',
          parameters: parameters.map((text) => ({ type: 'text', text: String(text) })),
        }],
      },
    });
  }

  private async post(payload: unknown): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;
    const response = await callFetch(this.fetch, url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }, 'WhatsApp Cloud API');
    const result = await readJson(response);
    if (!response.ok) {
      const detail = str(field(field(result, 'error'), 'message')) ?? `WhatsApp API returned HTTP ${response.status}`;
      throw classify(response.status, detail);
    }
    const messages = field(result, 'messages');
    const firstId = str(field(Array.isArray(messages) ? messages[0] : undefined, 'id'));
    return { mode: 'live', providerMessageId: firstId ?? randomUUID(), whatsappUrl: null, response: result };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Twilio
// ─────────────────────────────────────────────────────────────────────────

export class TwilioWhatsAppClient implements WhatsAppSender {
  readonly provider = 'twilio' as const;
  private readonly config: WhatsAppConfigInput;
  private readonly fetch: AlertFetch;

  constructor(config: WhatsAppConfigInput, fetchImpl: AlertFetch = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get fromNumber(): string {
    return normalizeE164(this.config.twilioFromNumber || TWILIO_SANDBOX_NUMBER);
  }

  get live(): boolean {
    return Boolean(this.config.twilioAccountSid && this.config.twilioAuthToken && this.fromNumber);
  }

  /** The shared Sandbox number accepts free text from numbers that joined it. */
  get sandbox(): boolean {
    return this.fromNumber === TWILIO_SANDBOX_NUMBER;
  }

  status(): WhatsAppStatus {
    return {
      mode: this.live ? 'live' : 'preview',
      provider: 'twilio',
      sandbox: this.sandbox,
      reportTemplateConfigured: this.live && (this.sandbox || Boolean(this.config.twilioReportContentSid)),
      reminderTemplateConfigured: this.live && Boolean(this.config.twilioReminderContentSid),
    };
  }

  async sendReport(alert: WhatsAppAlert): Promise<SendResult> {
    if (!this.live) return manualPreview(alert);
    if (this.config.twilioReportContentSid) {
      return this.sendContent(alert.to, this.config.twilioReportContentSid, alert.templateParams);
    }
    return this.sendText(alert.to, alert.text);
  }

  async sendReminder(alert: WhatsAppAlert): Promise<SendResult> {
    if (!this.live) return { ...manualPreview(alert), skipped: true, reason: 'WhatsApp preview mode' };
    if (!this.config.twilioReminderContentSid) {
      throw new DataError('TWILIO_REMINDER_CONTENT_SID is required for automatic 3-week reminders.');
    }
    return this.sendContent(alert.to, this.config.twilioReminderContentSid, alert.templateParams);
  }

  private async sendText(to: string, body: string): Promise<SendResult> {
    return this.post(new URLSearchParams({
      To: `whatsapp:${normalizeE164(to)}`,
      From: `whatsapp:${this.fromNumber}`,
      Body: body,
    }));
  }

  private async sendContent(to: string, contentSid: string, parameters: readonly string[]): Promise<SendResult> {
    return this.post(new URLSearchParams({
      To: `whatsapp:${normalizeE164(to)}`,
      From: `whatsapp:${this.fromNumber}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(Object.fromEntries(
        parameters.map((value, index) => [String(index + 1), String(value)]),
      )),
    }));
  }

  private async post(body: URLSearchParams): Promise<SendResult> {
    const credentials = Buffer.from(`${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.twilioAccountSid}/Messages.json`;
    const response = await callFetch(this.fetch, url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }, 'Twilio');
    const result = await readJson(response);
    if (!response.ok) {
      throw classify(response.status, str(field(result, 'message')) ?? `Twilio API returned HTTP ${response.status}`);
    }
    return { mode: 'live', providerMessageId: str(field(result, 'sid')) ?? randomUUID(), whatsappUrl: null, response: result };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WAHA — local QR gateway
// ─────────────────────────────────────────────────────────────────────────

/** Session states that mean a human must scan a QR before anything can be sent. */
const WAHA_QR_STATES = ['SCAN_QR_CODE', 'NOT_CREATED', 'STOPPED', 'FAILED'];

export class WahaWhatsAppClient implements WhatsAppSender {
  readonly provider = 'waha' as const;
  private readonly config: WhatsAppConfigInput;
  private readonly fetch: AlertFetch;
  /** Liveness is the CACHED probe result; status() is what refreshes it. */
  private lastSessionStatus = 'UNKNOWN';
  private lastError: string | null = null;

  constructor(config: WhatsAppConfigInput, fetchImpl: AlertFetch = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  get baseUrl(): string {
    return String(this.config.wahaBaseUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }

  get session(): string {
    return String(this.config.wahaSession || 'default');
  }

  get live(): boolean {
    return this.lastSessionStatus === 'WORKING';
  }

  async status(): Promise<WhatsAppStatus> {
    try {
      const session = await this.request(`/api/sessions/${encodeURIComponent(this.session)}`, {}, { allowNotFound: true });
      this.lastSessionStatus = str(field(session, 'status')) ?? 'NOT_CREATED';
      this.lastError = null;
    } catch (error) {
      // A dead container is a state to report, not a throw: the caller still
      // gets a usable manual fallback out of sendReport.
      this.lastSessionStatus = 'UNREACHABLE';
      this.lastError = errMsg(error);
    }
    return this.statusSnapshot();
  }

  private statusSnapshot(): WhatsAppStatus {
    return {
      mode: this.live ? 'live' : 'preview',
      provider: 'waha',
      session: this.session,
      sessionStatus: this.lastSessionStatus,
      qrRequired: WAHA_QR_STATES.includes(this.lastSessionStatus),
      // WAHA has no template concept — a connected session can send anything.
      reportTemplateConfigured: this.live,
      reminderTemplateConfigured: this.live,
      error: this.lastError,
    };
  }

  /** Create/start/restart the session as its current state requires. */
  async startSession(): Promise<WhatsAppStatus> {
    let session = await this.request(`/api/sessions/${encodeURIComponent(this.session)}`, {}, { allowNotFound: true });
    if (!session) {
      session = await this.request('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: this.session, start: true }),
      });
    } else if (str(field(session, 'status')) === 'STOPPED') {
      session = await this.request(`/api/sessions/${encodeURIComponent(this.session)}/start`, { method: 'POST' });
    } else if (str(field(session, 'status')) === 'FAILED') {
      session = await this.request(`/api/sessions/${encodeURIComponent(this.session)}/restart`, { method: 'POST' });
    }
    this.lastSessionStatus = str(field(session, 'status')) ?? 'STARTING';
    this.lastError = null;
    return this.statusSnapshot();
  }

  /** The pairing QR as a data: URL, safe to render in the ops console. */
  async qrCode(): Promise<{ dataUrl: string }> {
    await this.startSession();
    // Note the path: /api/<session>/auth/qr, NOT under /api/sessions.
    const response = await callFetch(this.fetch, `${this.baseUrl}/api/${encodeURIComponent(this.session)}/auth/qr`, {
      headers: { Accept: 'application/json', ...this.authHeader() },
    }, 'WAHA');
    if (!response.ok) throw await this.responseError(response);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const result = await response.json();
      const mimetype = str(field(result, 'mimetype')) ?? str(field(result, 'mimeType')) ?? 'image/png';
      const data = str(field(result, 'data')) ?? str(field(result, 'value')) ?? str(field(result, 'qr'));
      if (!data) throw new TransientError('WAHA did not return a QR code yet. Try again in a moment.');
      return { dataUrl: data.startsWith('data:') ? data : `data:${mimetype};base64,${data}` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new TransientError('WAHA did not return a QR code yet. Try again in a moment.');
    return { dataUrl: `data:${contentType || 'image/png'};base64,${bytes.toString('base64')}` };
  }

  async sendReport(alert: WhatsAppAlert): Promise<SendResult> {
    if (!await this.isWorking()) return manualPreview(alert);
    return this.sendText(alert.to, alert.text);
  }

  async sendReminder(alert: WhatsAppAlert): Promise<SendResult> {
    if (!await this.isWorking()) {
      return { ...manualPreview(alert), skipped: true, reason: 'WAHA session is not connected' };
    }
    return this.sendText(alert.to, alert.text);
  }

  /** Every send re-probes: a paired phone can drop between two messages. */
  private async isWorking(): Promise<boolean> {
    const status = await this.status();
    return status.mode === 'live';
  }

  private async sendText(to: string, body: string): Promise<SendResult> {
    const result = await this.request('/api/sendText', {
      method: 'POST',
      body: JSON.stringify({
        session: this.session,
        // WhatsApp chat ids are bare digits; normalizeE164 adds the '+' this strips.
        chatId: `${normalizeE164(to).slice(1)}@c.us`,
        text: body,
      }),
    });
    const id = str(field(result, 'id'))
      ?? str(field(field(field(result, '_data'), 'id'), 'id'))
      ?? str(field(field(result, 'key'), 'id'));
    return { mode: 'live', providerMessageId: id ?? randomUUID(), whatsappUrl: null, response: result };
  }

  private async request(
    pathname: string,
    options: AlertFetchInit = {},
    { allowNotFound = false }: { allowNotFound?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...this.authHeader(),
      ...(options.headers ?? {}),
    };
    const response = await callFetch(this.fetch, `${this.baseUrl}${pathname}`, { ...options, headers }, 'WAHA');
    // 404 on the session probe means "not created yet", which is a state.
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw await this.responseError(response);
    if (response.status === 204) return {};
    return readJson(response);
  }

  private authHeader(): Record<string, string> {
    return this.config.wahaApiKey ? { 'X-Api-Key': this.config.wahaApiKey } : {};
  }

  private async responseError(response: AlertFetchResponse): Promise<Error> {
    const result = await readJson(response);
    const detail = str(field(result, 'message')) ?? str(field(result, 'error')) ?? `WAHA returned HTTP ${response.status}`;
    return classify(response.status, detail);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Selection + config
// ─────────────────────────────────────────────────────────────────────────

export function createWhatsAppClient(
  config: WhatsAppConfigInput = whatsappConfigFromEnv(),
  fetchImpl: AlertFetch = globalThis.fetch,
): WhatsAppSender {
  const provider = String(config.provider || 'meta').toLowerCase();
  if (provider === 'waha') return new WahaWhatsAppClient(config, fetchImpl);
  if (provider === 'twilio') return new TwilioWhatsAppClient(config, fetchImpl);
  return new WhatsAppClient(config, fetchImpl);
}

/** Same variable names as the prototype, so an existing .env moves across untouched. */
export function whatsappConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig {
  return {
    provider: (env.WHATSAPP_PROVIDER || 'meta').toLowerCase(),
    accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
    reportTemplate: env.WHATSAPP_REPORT_TEMPLATE ?? '',
    reminderTemplate: env.WHATSAPP_REMINDER_TEMPLATE ?? '',
    templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE || 'id',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? '',
    twilioFromNumber: env.TWILIO_WHATSAPP_FROM || TWILIO_SANDBOX_NUMBER,
    twilioReportContentSid: env.TWILIO_REPORT_CONTENT_SID ?? '',
    twilioReminderContentSid: env.TWILIO_REMINDER_CONTENT_SID ?? '',
    wahaBaseUrl: (env.WAHA_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
    wahaApiKey: env.WAHA_API_KEY ?? '',
    wahaSession: env.WAHA_SESSION || 'default',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * No provider connected: hand back a click-to-chat link with the message
 * pre-filled instead of sending. Staff finish it from their own WhatsApp, so a
 * gateway that is down degrades to slower, not to silence.
 */
function manualPreview(alert: WhatsAppAlert): SendResult {
  return {
    mode: 'manual',
    providerMessageId: null,
    whatsappUrl: `https://wa.me/${alert.to}?text=${encodeURIComponent(alert.text)}`,
    message: alert.text,
  };
}

/**
 * Serialise digits as E.164. This is NOT phone normalisation — the Indonesian
 * 0-vs-62 work happens once, at the edge, in indonesia.ts (parseWa), and
 * `alert.to` arrives here already canonical.
 *
 * DEVIATION from the source, which returned the unroutable "+081234567890" for
 * a local number: a leading 0 is resolved with this repo's canonPhoneKey. The
 * source got away with it because its ingest guaranteed no leading zero ever
 * reached this function; ours has 23 branches typing numbers by hand, and a
 * silent +62/0 mismatch has already cost us once. Foreign numbers are still
 * passed through untouched, so the Twilio/WAHA bytes stay identical.
 */
function normalizeE164(value: string): string {
  const digits = String(value ?? '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `+62${canonPhoneKey(digits)}`;
  return `+${digits}`;
}

/** 429 and 5xx are worth another attempt; a 4xx is a fact about the request. */
function classify(status: number, message: string): Error {
  return status === 429 || status >= 500 ? new TransientError(message) : new DataError(message);
}

/** A refused connection is the gateway's problem, never the customer's data. */
async function callFetch(fetchImpl: AlertFetch, url: string, init: AlertFetchInit, who: string): Promise<AlertFetchResponse> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new TransientError(`${who} unreachable: ${errMsg(error)}`);
  }
}

/** An unparseable body must not mask the status code that explains it. */
async function readJson(response: AlertFetchResponse): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
