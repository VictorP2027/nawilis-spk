/**
 * Fill the Inspection List on an EXISTING Turboly Service Order — the answer
 * to "where do the Check & Go selections go in Turboly?" (Turboly's own
 * guidance, 2026-08-07: the Inspection List becomes the SRO's notes and is
 * what /reports/inspection_lists exports per line).
 *
 * Mechanism: the SO EDIT page (/service_orders/:id/edit) embeds the
 * inspection lines as plain Rails nested attributes —
 *   service_order[service_order_inspection_lines_attributes][N][description|notes|inspected|category|_destroy]
 * — and, unlike the CREATE form, renders every other control server-side
 * with its current value (advisor/salesperson options included), so parsing
 * the form and PATCHing it back round-trips the SO faithfully. Service lines
 * are NOT embedded in this form, so they cannot be clobbered.
 *
 * Discovered and proven against sandbox SO 243222 on 2026-08-07.
 */
import { DataError, TransientError } from '../failure.js';

export interface InspectionRow {
  description: string;
  /** Rendered in the detail page's "Feedback" column and the report's Notes. */
  notes: string;
  inspected: boolean;
}

export interface HttpInspectionConfig {
  baseUrl: string;
  username: string;
  password: string;
}

const WHAT = 'Inspection List';

function cookiesFrom(res: Response): string {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

/** Later cookies override earlier ones by name — Rails rotates _session_id per response. */
function mergeCookies(base: string, update: string): string {
  const jar = new Map<string, string>();
  for (const part of `${base}; ${update}`.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k && v.length) jar.set(k, v.join('='));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(cfg: HttpInspectionConfig): Promise<string> {
  const r1 = await fetch(`${cfg.baseUrl}/users/sign_in`, { redirect: 'manual' });
  const pre = cookiesFrom(r1);
  const token = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(await r1.text())?.[1] ?? '';
  const res = await fetch(`${cfg.baseUrl}/users/sign_in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'user[email]': cfg.username,
      'user[password]': cfg.password,
      authenticity_token: token,
      commit: 'Login',
    }).toString(),
  });
  const cookie = cookiesFrom(res) || pre;
  if (res.status === 302 && cookie) return cookie;
  if (res.status >= 500) throw new TransientError(`${WHAT}: Turboly tidak bisa diakses saat login — dicoba ulang otomatis`);
  throw new DataError(`${WHAT}: login Turboly ditolak (HTTP ${res.status})`);
}

const unesc = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * Serialize the edit form the way a browser would: text/hidden inputs by
 * value, checkboxes only when checked (their hidden-0 shadow is a separate
 * control that is always present), selects by their selected option.
 */
function serializeForm(formHtml: string): URLSearchParams {
  const body = new URLSearchParams();
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /name="([^"]+)"/.exec(tag)?.[1];
    if (!name) continue;
    const type = (/type="([^"]+)"/.exec(tag)?.[1] ?? 'text').toLowerCase();
    if (type === 'file' || type === 'submit' || type === 'button' || type === 'image') continue;
    const value = unesc(/value="([^"]*)"/.exec(tag)?.[1] ?? '');
    if (type === 'checkbox' || type === 'radio') {
      if (/\bchecked\b/.test(tag)) body.append(unesc(name), value || '1');
      continue;
    }
    body.append(unesc(name), value);
  }
  for (const m of formHtml.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = unesc(m[1] ?? '');
    const inner = m[2] ?? '';
    const sel = /<option[^>]*\bselected\b[^>]*value="([^"]*)"/.exec(inner) ?? /<option[^>]*value="([^"]*)"[^>]*\bselected\b/.exec(inner);
    if (name) body.append(name, unesc(sel?.[1] ?? ''));
  }
  for (const m of formHtml.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    if (m[1]) body.append(unesc(m[1]), unesc(m[2] ?? ''));
  }
  return body;
}

/**
 * Replace the SO's inspection lines with `rows` and save. Existing lines are
 * kept-and-overwritten by index (their [id] fields are preserved from the
 * form); extra old lines beyond rows.length are flagged _destroy.
 */
export async function fillServiceOrderInspection(
  cfg: HttpInspectionConfig,
  serviceOrderId: string,
  rows: InspectionRow[],
  category: string,
): Promise<{ ok: true; rows: number }> {
  if (!rows.length) return { ok: true, rows: 0 };
  let cookie = await login(cfg);
  const editUrl = `${cfg.baseUrl}/service_orders/${serviceOrderId}/edit`;
  const r = await fetch(editUrl, { headers: { cookie }, redirect: 'manual' });
  if (r.status === 302) throw new TransientError(`${WHAT}: sesi ter-kick saat buka form edit — dicoba ulang otomatis`);
  if (r.status !== 200) throw new DataError(`${WHAT}: form edit SO ${serviceOrderId} tidak bisa dibuka (HTTP ${r.status})`);
  cookie = mergeCookies(cookie, cookiesFrom(r)); // Rails rotates the session; the form token pairs with THIS cookie
  const html = await r.text();
  const formMatch = /<form[^>]*action="[^"]*\/service_orders\/\d+"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) throw new DataError(`${WHAT}: form edit SO tidak ditemukan di halaman — struktur Turboly berubah`);
  const body = serializeForm(formMatch[0]);
  if (!body.get('authenticity_token')) {
    const tok = /name="csrf-token"[^>]*content="([^"]+)"/.exec(html)?.[1];
    if (tok) body.set('authenticity_token', tok);
  }
  body.set('_method', 'patch');

  // Preserve any existing line ids so Rails updates instead of duplicating.
  const existingIds = new Map<string, string>();
  for (const m of html.matchAll(/name="service_order\[service_order_inspection_lines_attributes\]\[(\d+)\]\[id\]"[^>]*value="([^"]*)"/g)) {
    const [, idx, id] = m;
    // A blank id is a Rails template row, not a saved line — carrying it would
    // make the PATCH try to update a record that does not exist.
    if (idx && id) existingIds.set(idx, id);
  }
  // Wipe whatever line fields the form serialization picked up, then write ours.
  for (const key of [...body.keys()]) {
    if (key.startsWith('service_order[service_order_inspection_lines_attributes]')) body.delete(key);
  }
  const P = 'service_order[service_order_inspection_lines_attributes]';
  rows.forEach((row, i) => {
    const id = existingIds.get(String(i));
    if (id) body.append(`${P}[${i}][id]`, id);
    body.append(`${P}[${i}][description]`, row.description.slice(0, 250));
    body.append(`${P}[${i}][notes]`, row.notes.slice(0, 250));
    body.append(`${P}[${i}][inspected]`, row.inspected ? '1' : '0');
    body.append(`${P}[${i}][category]`, category);
    body.append(`${P}[${i}][_destroy]`, 'false');
  });
  // Old rows beyond ours get destroyed rather than lingering half-stale.
  let extra = rows.length;
  for (const [idx, id] of existingIds) {
    if (Number(idx) < rows.length || !id) continue;
    body.append(`${P}[${extra}][id]`, id);
    body.append(`${P}[${extra}][_destroy]`, 'true');
    extra += 1;
  }

  const csrf = /name="csrf-token"[^>]*content="([^"]+)"/.exec(html)?.[1] ?? '';
  const save = await fetch(`${cfg.baseUrl}/service_orders/${serviceOrderId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: body.toString(),
  });
  if (save.status === 302) return { ok: true, rows: rows.length };
  const text = await save.text().catch(() => '');
  if (/sign_in/.test(text) || save.status === 401) throw new TransientError(`${WHAT}: sesi ter-kick saat simpan — dicoba ulang otomatis`);
  const err =
    /<div[^>]*id="error_explanation"[^>]*>([\s\S]{0,400}?)<\/div>/i.exec(text)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ??
    /<div[^>]*class="[^"]*alert-error[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/i.exec(text)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  throw new DataError(`${WHAT}: simpan gagal (HTTP ${save.status})${err ? ` — ${err}` : ''}`);
}

/**
 * The Check & Go rows in Turboly form: item → Description, the finding →
 * Feedback, and "was this actually looked at" → Inspected.
 *
 * Two things this has to get right, both learned from a live order that came
 * back reading TIDAK DIPERIKSA on all seven lines:
 *
 * 1. `hasil` is only ever set for rows that carry a printed VERDICT pair. Every
 *    tyre row and every "Rekomendasi …" row leaves it null and puts its real
 *    content in `catatan` — so keying Inspected off `hasil` marked a wheel with
 *    a recorded pressure, a brand and a crack as never examined. Any content at
 *    all means it was inspected; only a row with nothing on it is TIDAK
 *    DIPERIKSA, which is still worth sending because a blank line in the ERP
 *    should say why it is blank.
 * 2. `catatan` from rowsFromReport already OPENS with the verdict label, so
 *    joining the two printed it twice ("Bagus — Bagus"). Hand-typed rows from
 *    /checkgo/sheet keep them independent, so the two are only joined when
 *    `catatan` does not already lead with `hasil`.
 *
 * `feedback` is the mechanic's own verdict, recorded later on the flow board.
 * It REPLACES the checker's rather than joining it — the two describe the same
 * row at different times, so "PERLU PERBAIKAN kampas menipis — Tebal" would
 * print the finding and its own contradiction on one line. Same precedence as
 * buildCheckGoAlert; the checker's original stays in Mongo and on the printout.
 */
export function inspectionRowsFromCheckGo(
  items: Array<{ item: string; hasil?: string | null; catatan: string | null; feedback?: string | null; inspected?: boolean }>,
): InspectionRow[] {
  return items.map((it) => {
    const feedback = (it.feedback ?? '').trim();
    const hasil = (it.hasil ?? '').trim();
    const catatan = (it.catatan ?? '').trim();
    const checker =
      hasil && catatan && catatan !== hasil && !catatan.startsWith(hasil)
        ? `${hasil} — ${catatan}`
        : catatan || hasil;
    const notes = feedback || checker;
    return {
      description: it.item,
      notes: notes || 'TIDAK DIPERIKSA',
      inspected: it.inspected === true || notes !== '',
    };
  });
}
