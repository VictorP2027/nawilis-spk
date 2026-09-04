'use client';

/**
 * FLOW BOARD — the lifecycle centerpiece.
 *
 * Every active document (SPK + Check&Go) is a card in a stage column:
 *   Intake → Service Order → Work Order → QC → Invoice → Selesai
 *
 * Each card shows ONE primary next-step button. Clicking it opens a compact
 * confirm/params modal, then POSTs /api/flow/action { spkId, action, params }
 * which enqueues a flow job (executed serially by the RPA worker). The board
 * polls /api/flow/state every 10s: queued/running jobs render a spinner,
 * failed jobs render a red error chip with [Coba lagi].
 */

import BrandMark from './../components/BrandMark';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// Types — mirrors the /api/flow/state row projection (defensively normalized):
// { spkId, docType, branchCode, customer:{nama,wa}, plate, quotedTotal,
//   flow:{so,wo,invoice,workOrderNo,workOrderUrl,invoiceNo,invoiceUrl,…},
//   turboly:{serviceOrderNo,serviceOrderUrl,workOrderNo,invoiceNo},
//   column, nextAction, activeJob, failedJob }
// ─────────────────────────────────────────────────────────────────────────

interface SoInfo { no: string | null; url: string | null; approved: boolean }
interface WoInfo { no: string | null; url: string | null; status: string | null }
interface InvInfo { no: string | null; url: string | null; status: string | null }
interface PendingJob {
  attempts?: number | null; jobId: string | null; action: string; state: string; error: string | null }

interface FlowRow {
  _id: string; // = spkId on the wire
  docType: string; // 'SPK_NAWILIS' | 'CHECK_AND_GO' | …
  plate: string;
  customer: string;
  branchCode: string;
  /** Server-derived board column (same helper the action route guards with). */
  column: ColKey;
  /** Server-derived ONE next action (canonical name, e.g. 'create_wo'). */
  nextAction: string | null;
  so: SoInfo | null;
  wo: WoInfo | null;
  invoice: InvInfo | null;
  pendingJob: PendingJob | null;
  total: number;
  /** Check & Go WhatsApp stamp: null | 'requested' | 'live' | 'failed' | 'manual'. */
  waAlert: string | null;
  /** Set when this SPK's lines were added to the car's Check & Go order instead of a second one. */
  mergedIntoNo: string | null;
  /** What a human still has to do about that merge (WO already made, notes not carried, re-approval). */
  mergeWarnings: string[];
}

interface Mechanic { code: string; name: string; role: string | null }

/** Which params UI an action needs. */
type FieldsKind = 'none' | 'mechanic' | 'complete' | 'qc' | 'payment';

interface ActionDef {
  action: string;
  label: string;
  fields: FieldsKind;
  /** Short confirm line shown in the modal. */
  hint: string;
}

// Keyed by the CANONICAL action names the server uses everywhere (flow.ts
// FLOW_ACTIONS, job briefs, row.nextAction) — the modal posts these verbatim.
// Params follow the worker's expectations ({assigneeName}, {waktuMinutes,
// feedback}, {nextOdometer, nextServiceDateISO, recommendations}, {method, amount}).
const ACTIONS: Record<string, ActionDef> = {
  // approve_so is deliberately ABSENT. The branches now approve the Service
  // Order inside Turboly itself, so this button re-approved something already
  // approved and the card sat in "Service Order" looking stuck. Dropping the
  // entry is all it takes: nextActionFor() looks the name up here, so a card
  // waiting on approval simply shows no button (and keeps its SO link and its
  // print icon). The action still exists server-side in flow.ts and is still
  // reachable through /api/flow/action — this removes the BUTTON, not the
  // capability.
  create_wo: { action: 'create_wo', label: 'Buat Work Order', fields: 'mechanic', hint: 'Work Order dibuat dari SO yang sudah approved — pilih mekanik.' },
  start_wo: { action: 'start_wo', label: 'Start', fields: 'none', hint: 'Pekerjaan dimulai (WO → IN PROGRESS).' },
  complete_wo: { action: 'complete_wo', label: 'Selesai', fields: 'complete', hint: 'Tandai pekerjaan selesai — isi durasi & temuan.' },
  qc_ok: { action: 'qc_ok', label: 'QC OK', fields: 'qc', hint: 'QC lolos — isi rekomendasi servis berikutnya.' },
  create_invoice: { action: 'create_invoice', label: 'Buat Invoice', fields: 'payment', hint: 'Invoice dibuat dari WO yang selesai.' },
  complete_invoice: { action: 'complete_invoice', label: 'Selesaikan Invoice', fields: 'payment', hint: 'Pembayaran dicatat dan invoice diselesaikan.' },
  stay_check_only: { action: 'stay_check_only', label: 'Tetap Check Saja', fields: 'none', hint: 'Customer tidak setuju perbaikan — dokumen tetap check-only, semua temuan tersimpan.' },
};

const PAYMENT_METHODS = ['Cash', 'Transfer', 'QRIS', 'EDC'] as const;

// ─────────────────────────────────────────────────────────────────────────
// Columns — ids match the server's boardColumn() output exactly.
// ─────────────────────────────────────────────────────────────────────────

type ColKey = 'intake' | 'so' | 'wo' | 'qc' | 'invoice' | 'done';
const COL_KEYS: readonly ColKey[] = ['intake', 'so', 'wo', 'qc', 'invoice', 'done'];

const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'so', label: 'Service Order' },
  { key: 'wo', label: 'Work Order' },
  { key: 'qc', label: 'QC' },
  { key: 'invoice', label: 'Invoice' },
  { key: 'done', label: 'Selesai' },
];

/** The next-step button def for a card (null = nothing to do / waiting). */
function nextActionFor(row: FlowRow): ActionDef | null {
  return row.nextAction ? ACTIONS[row.nextAction] ?? null : null;
}

/** Small status chip text on the card. */
function stageChip(row: FlowRow): { text: string; cls: string } {
  if (row.mergedIntoNo) return { text: `Digabung ke SO ${row.mergedIntoNo}`, cls: 'gray' };
  switch (row.column) {
    case 'intake': return { text: 'Menunggu SO', cls: 'gray' };
    case 'so': return row.so?.approved ? { text: 'SO approved', cls: 'green' } : { text: 'SO dibuat', cls: 'blue' };
    case 'wo': return row.wo?.status === 'in_progress' ? { text: 'Dikerjakan', cls: 'blue' } : { text: 'WO menunggu', cls: 'gray' };
    case 'qc': return { text: 'Tunggu QC', cls: 'yellow' };
    case 'invoice': return row.invoice?.no ? { text: 'Invoice draft', cls: 'yellow' } : { text: 'Siap invoice', cls: 'green' };
    default: return { text: 'Selesai', cls: 'green' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Row normalization — never trust the wire shape blindly (strict + defensive).
// ─────────────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Fallback column derivation (only when the server sent no/unknown column). */
function deriveColumn(so: SoInfo | null, wo: WoInfo | null, inv: InvInfo | null): ColKey {
  if (inv?.status === 'completed') return 'done';
  if (inv?.status === 'draft' || inv?.no) return 'invoice';
  if (wo?.status === 'completed') return 'invoice'; // QC lolos — tinggal buat invoice
  if (wo?.status === 'waiting_qc') return 'qc';
  if (wo?.status || wo?.no) return 'wo';
  if (so) return 'so';
  return 'intake';
}

/** One job brief ({jobId, action, state, error}) from the wire, or null. */
function normJob(raw: unknown): PendingJob | null {
  const j = obj(raw);
  const action = j ? str(j.action) : null;
  if (!j || !action) return null;
  const att = typeof j.attempts === 'number' ? j.attempts : null;
  return { jobId: str(j.jobId) ?? str(j._id), action, state: str(j.state) ?? 'queued', error: str(j.error), attempts: att };
}

function normRow(raw: unknown): FlowRow | null {
  const r = obj(raw);
  const id = r ? str(r.spkId) ?? str(r._id) : null;
  if (!r || !id) return null;

  const flow = obj(r.flow);
  const tb = obj(r.turboly);
  const cust = obj(r.customer);

  const soStage = flow ? str(flow.so) : null;
  const soNo = tb ? str(tb.serviceOrderNo) : null;
  const so: SoInfo | null =
    soNo || soStage ? { no: soNo, url: tb ? str(tb.serviceOrderUrl) : null, approved: soStage === 'approved' } : null;

  const woStage = flow ? str(flow.wo) : null;
  const woNo = (flow ? str(flow.workOrderNo) : null) ?? (tb ? str(tb.workOrderNo) : null);
  const wo: WoInfo | null =
    woNo || woStage ? { no: woNo, url: flow ? str(flow.workOrderUrl) : null, status: woStage } : null;

  const invStage = flow ? str(flow.invoice) : null;
  const invNo = (flow ? str(flow.invoiceNo) : null) ?? (tb ? str(tb.invoiceNo) : null);
  const invoice: InvInfo | null =
    invNo || invStage ? { no: invNo, url: flow ? str(flow.invoiceUrl) : null, status: invStage } : null;

  const colRaw = str(r.column);
  const column: ColKey = (COL_KEYS as readonly string[]).includes(colRaw ?? '')
    ? (colRaw as ColKey)
    : deriveColumn(so, wo, invoice);

  // While a job is in flight the card shows a spinner; a failed one shows the
  // error chip + retry. activeJob wins (the server nulls failedJob then too).
  const pendingJob = normJob(r.activeJob) ?? normJob(r.failedJob);

  return {
    _id: id,
    docType: str(r.docType) ?? 'SPK_NAWILIS',
    plate: str(r.plate) ?? '—',
    customer: (cust ? str(cust.nama) : null) ?? str(r.customer) ?? '—',
    branchCode: str(r.branchCode) ?? '',
    column,
    nextAction: str(r.nextAction),
    so,
    wo,
    invoice,
    pendingJob,
    total: typeof r.quotedTotal === 'number' && Number.isFinite(r.quotedTotal) ? r.quotedTotal : 0,
    waAlert: (() => { const a = obj(obj(r.checkGo)?.alert); return a ? str(a.mode) : null; })(),
    // A merged SPK is NOT a finished job: its work sits on the Check & Go's
    // order and still has to be approved, worked and invoiced from THAT card.
    // Without this the card showed a green "Selesai" and staff counted it as done.
    mergedIntoNo: (() => { const m = obj(r.mergedInto); return m ? str(m.serviceOrderNo) ?? '—' : null; })(),
    mergeWarnings: (() => {
      const m = obj(r.mergedInto);
      const w = m?.warnings;
      return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string' && x !== '') : [];
    })(),
  };
}

function rp(n: number): string {
  return `Rp ${n.toLocaleString('id-ID')}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Action modal — one component, field set switches on def.fields.
// ─────────────────────────────────────────────────────────────────────────

interface ModalProps {
  row: FlowRow;
  def: ActionDef;
  onClose: () => void;
  onDone: (spkId: string, action: string) => void;
}

function ActionModal({ row, def, onClose, onDone }: ModalProps) {
  const [mechanics, setMechanics] = useState<Mechanic[]>([]);
  const [mechLoading, setMechLoading] = useState(def.fields === 'mechanic');
  const [assignee, setAssignee] = useState('');
  const [waktu, setWaktu] = useState('');
  const [findings, setFindings] = useState('');
  const [nextOdo, setNextOdo] = useState('');
  const [nextDate, setNextDate] = useState(() => {
    // Default reminder: +6 bulan (boleh dikosongkan).
    const d = new Date(Date.now() + 182 * 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [rekomendasi, setRekomendasi] = useState('');
  const [method, setMethod] = useState<string>('Cash');
  const [amount, setAmount] = useState(row.total > 0 ? String(row.total) : '');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (def.fields !== 'mechanic') return;
    let live = true;
    fetch(`/api/mechanics?branch=${encodeURIComponent(row.branchCode)}`)
      .then((r) => r.json())
      .then((d: unknown) => {
        if (!live) return;
        const o = obj(d);
        const list = (o && (Array.isArray(o.mechanics) ? o.mechanics : Array.isArray(o.rows) ? o.rows : [])) as unknown[];
        const out: Mechanic[] = [];
        for (const m of list) {
          const mo = obj(m);
          if (!mo) continue;
          const name = str(mo.name);
          if (!name) continue;
          // Prefer the server's capability label; fall back to the raw role so
          // an older deployment of the API still renders something sane.
          out.push({ code: str(mo.code) ?? str(mo.mechanicCode) ?? str(mo._id) ?? name, name, role: str(mo.label) ?? str(mo.role) });
        }
        setMechanics(out);
        setMechLoading(false);
      })
      .catch(() => { if (live) setMechLoading(false); });
    return () => { live = false; };
  }, [def.fields, row.branchCode]);

  const amountNum = Number(amount.replace(/[.\s]/g, '')) || 0;
  const amountDiff = row.total > 0 && amountNum > 0 && amountNum !== row.total;

  // Per-action validity gate for the submit button.
  const valid =
    def.fields === 'none' ? true
    : def.fields === 'mechanic' ? assignee.trim() !== ''
    : def.fields === 'complete' ? /^\d+$/.test(waktu.trim()) && Number(waktu) > 0
    : def.fields === 'qc' ? true // semua input QC opsional (rekomendasi servis berikutnya)
    : amountNum > 0;

  function buildParams(): Record<string, unknown> {
    switch (def.fields) {
      case 'mechanic':
        // Send the Turboly store-user id when the operator picked from the list.
        // Names are not unique in Turboly (two ADITYA SAPUTRAs), so the id is
        // the only exact answer; the name still goes along for the audit trail
        // and for the typed-name fallback when a branch has no synced list.
        return {
          assigneeName: assignee.trim(),
          assigneeCode: mechanics.find((m) => m.name === assignee.trim())?.code ?? null,
        };
      case 'complete':
        return { waktuMinutes: Number(waktu), feedback: findings.trim() || null };
      case 'qc':
        return {
          nextOdometer: /^\d+$/.test(nextOdo.replace(/[.\s]/g, '')) && nextOdo.trim() !== '' ? Number(nextOdo.replace(/[.\s]/g, '')) : null,
          nextServiceDateISO: nextDate ? new Date(`${nextDate}T09:00:00+07:00`).toISOString() : null,
          recommendations: rekomendasi.trim() || null,
        };
      case 'payment':
        return { method, amount: amountNum };
      default:
        return {};
    }
  }

  async function submit() {
    if (!valid || posting) return;
    setPosting(true);
    setErr(null);
    try {
      const res = await fetch('/api/flow/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spkId: row._id, action: def.action, params: buildParams() }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setErr(str(body.error) ?? str(body.message) ?? `Gagal (HTTP ${res.status})`);
        setPosting(false);
        return;
      }
      onDone(row._id, def.action);
    } catch {
      setErr('Jaringan bermasalah — coba lagi.');
      setPosting(false);
    }
  }

  return (
    <div className="ovr-overlay" onClick={onClose}>
      <div className="ovr-card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="fb-mtitle">{def.label}</div>
        <div className="fb-msub">
          <b>{row.plate}</b> · {row.customer} · {row.branchCode}
          {row.so?.no ? <> · {row.so.no}</> : null}
          {row.wo?.no ? <> · {row.wo.no}</> : null}
          {row.invoice?.no ? <> · {row.invoice.no}</> : null}
        </div>
        <div className="fb-mhint">{def.hint}</div>

        {def.fields === 'mechanic' && (
          <div style={{ marginTop: 12 }}>
            <div className="label">Mekanik (assignee)</div>
            {mechLoading ? (
              <div className="fb-wait"><span className="fb-spin" /> Memuat daftar mekanik…</div>
            ) : mechanics.length > 0 ? (
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">— pilih mekanik —</option>
                {mechanics.map((m) => (
                  <option key={m.code} value={m.name} data-code={m.code}>{m.name}{m.role ? ` (${m.role})` : ''}</option>
                ))}
              </select>
            ) : (
              <>
                <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Nama mekanik — harus sama dengan di Turboly" />
                <div className="warn-note">⚠ Daftar mekanik cabang kosong — ketik nama persis seperti di Turboly.</div>
              </>
            )}
            {!valid && !mechLoading && <div className="req-note">⚠ wajib pilih mekanik</div>}
          </div>
        )}

        {def.fields === 'complete' && (
          <div style={{ marginTop: 12 }}>
            <div className="label">Waktu pengerjaan (menit)</div>
            <input value={waktu} onChange={(e) => setWaktu(e.target.value)} inputMode="numeric" placeholder="60" style={!valid ? { borderColor: '#dc2626', maxWidth: 140 } : { maxWidth: 140 }} />
            {!valid && <div className="req-note">⚠ wajib — angka menit, contoh 60</div>}
            <div className="label" style={{ marginTop: 12 }}>Temuan / feedback pengerjaan</div>
            <textarea value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} placeholder="Hasil pengecekan / pekerjaan yang dilakukan" />
            <button
              type="button"
              className="btn ghost"
              style={{ fontSize: 12, padding: '6px 10px', marginTop: 6 }}
              onClick={() => setFindings((f) => f || 'From inspection, there was problem with … so we did ….')}
            >
              Pakai template temuan
            </button>
          </div>
        )}

        {def.fields === 'qc' && (
          <div style={{ marginTop: 12 }}>
            <div className="row">
              <div>
                <div className="label">Next odometer (KM)</div>
                <input value={nextOdo} onChange={(e) => setNextOdo(e.target.value)} inputMode="numeric" placeholder="mis. 55.000" />
              </div>
              <div>
                <div className="label">Next service date</div>
                <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
              </div>
            </div>
            <div className="label" style={{ marginTop: 12 }}>Rekomendasi servis berikutnya</div>
            <textarea value={rekomendasi} onChange={(e) => setRekomendasi(e.target.value)} rows={3} placeholder="mis. Ganti oli + cek rem pada servis berikutnya" />
            <div className="ok-sm">Semua kolom opsional — kosongkan jika tidak ada rekomendasi.</div>
          </div>
        )}

        {def.fields === 'payment' && (
          <div style={{ marginTop: 12 }}>
            <div className="row">
              <div>
                <div className="label">Metode pembayaran</div>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Jumlah (Rp)</div>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder={row.total > 0 ? String(row.total) : 'jumlah'} style={!valid ? { borderColor: '#dc2626' } : undefined} />
              </div>
            </div>
            {!valid && <div className="req-note">⚠ wajib — jumlah pembayaran</div>}
            {row.total > 0 && <div className="ok-sm">Total dokumen: {rp(row.total)}</div>}
            {amountDiff && <div className="warn-note">⚠ Jumlah berbeda dari total {rp(row.total)} — pastikan memang benar (diskon/pembulatan).</div>}
          </div>
        )}

        {err && <div className="finding BLOCK" style={{ marginTop: 12 }}>{err}</div>}

        <div className="ovr-actions" style={{ marginTop: 16 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={posting}>Batal</button>
          <button type="button" className="btn primary" style={{ width: 'auto' }} disabled={!valid || posting} onClick={submit}>
            {posting ? <><span className="fb-spin fb-spin-w" /> Mengirim…</> : def.label}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp confirm — the human gate in front of the customer's phone.
// ─────────────────────────────────────────────────────────────────────────

interface WaPreview {
  profile: { nama: string; wa: string | null; plate: string; branch: string };
  to: string;
  /** Effective message: a pending staff edit when one is stored, else canonical. */
  text: string;
  /** Regenerated canonical wording — what "Kembalikan asli" restores. */
  canonicalText?: string;
  /** The doc's CURRENT stamp — board rows can be a poll-interval stale. */
  status?: { mode?: string | null; by?: string | null } | null;
}

/** True when the fresh GET says someone already handled this customer. */
function waHandled(p: WaPreview | null): boolean {
  const m = p?.status?.mode ?? null;
  return m === 'live' || m === 'requested' || (m === 'manual' && Boolean(p?.status?.by));
}

/**
 * Nothing is sent from here. [Kirim] stamps the doc 'requested'; the drainer
 * running beside the WAHA gateway delivers within a tick. The preview is the
 * EXACT text the customer receives — fetched from the server, not rebuilt in
 * the browser, so what staff approve is what goes out.
 */
function WaModal({ row, onClose, onDone }: { row: FlowRow; onClose: () => void; onDone: (spkId: string) => void }) {
  const [data, setData] = useState<WaPreview | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/checkgo/${encodeURIComponent(row._id)}/alert`, { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!r.ok) { setErr(str(body.message) ?? 'Tidak bisa memuat pesan.'); return; }
        setData(body as unknown as WaPreview);
        setDraft((body as unknown as WaPreview).text);
      })
      .catch(() => { if (live) setErr('Jaringan bermasalah — coba lagi.'); });
    return () => { live = false; };
  }, [row._id]);

  async function send() {
    setPosting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/checkgo/${encodeURIComponent(row._id)}/alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Edited text rides on the stamp; the gateway drainer sends the
        // approved wording instead of regenerating it.
        body: JSON.stringify({ by: 'flow-board', ...(data !== null && draft.trim() !== '' && draft !== (data.canonicalText ?? data.text) ? { text: draft } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setErr(res.status === 409 ? 'Pesan sudah pernah terkirim ke customer ini.' : str(body.message) ?? 'Gagal antre kirim.');
        setPosting(false);
        return;
      }
      onDone(row._id);
    } catch {
      setErr('Jaringan bermasalah — coba lagi.');
      setPosting(false);
    }
  }

  return (
    <div className="ovr-overlay" onClick={onClose}>
      <div className="ovr-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="fb-mtitle">Kirim Hasil Check &amp; Go via WhatsApp</div>
        {err && <div className="fb-errchip" style={{ marginTop: 10 }}><div className="fb-errtxt">✗ {err}</div></div>}
        {!data && !err && <div className="fb-wait" style={{ marginTop: 10 }}><span className="fb-spin" /> Memuat pesan…</div>}
        {data && (
          <>
            <div className="fb-msub" style={{ marginTop: 8 }}>
              <b>{data.profile.nama}</b> · {data.profile.wa ?? data.to} · {data.profile.plate} · {data.profile.branch}
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              maxLength={4000}
              disabled={posting}
              style={{ display: 'block', width: '100%', marginTop: 10, padding: 10, background: 'var(--surface-2, #f4f6fb)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', lineHeight: 1.45, resize: 'vertical' }}
            />
            <div className="fb-mhint" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span>✏️ Pesan bisa diedit — yang di kotak inilah yang dikirim. Periksa nama &amp; nomor dulu.</span>
              {draft !== (data.canonicalText ?? data.text) && (
                <button type="button" className="btn ghost" style={{ width: 'auto', padding: '3px 10px', fontSize: 12 }} onClick={() => setDraft(data.canonicalText ?? data.text)}>
                  ↺ Kembalikan asli
                </button>
              )}
            </div>
            {waHandled(data) && (
              <div className="fb-errchip" style={{ marginTop: 10 }}>
                <div className="fb-errtxt">
                  ⚠ Sudah ditangani ({data.status?.mode === 'live' ? 'terkirim gateway' : data.status?.mode === 'requested' ? 'antre gateway' : 'dikirim manual'}) —
                  mengirim lagi berarti customer menerima dua kali.
                </div>
              </div>
            )}
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Batal</button>
          {/* The zero-infrastructure path: opens plain WhatsApp Web with the
              message pre-filled — whoever is logged in there (personal or
              branch number) presses send themselves. */}
          <button
            type="button"
            className="btn ghost"
            disabled={!data || posting || waHandled(data) || draft.trim() === ''}
            onClick={() => {
              if (!data || waHandled(data) || draft.trim() === '') return;
              const text = draft;
              // A blocked popup means nothing was sent — refuse to stamp.
              const tab = window.open(`https://wa.me/${data.to}?text=${encodeURIComponent(text)}`, '_blank');
              if (tab === null) {
                setErr('Popup diblokir browser — izinkan popup untuk situs ini, lalu tekan tombol lagi.');
                return;
              }
              void fetch(`/api/checkgo/${encodeURIComponent(row._id)}/alert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ by: 'flow-board', manual: true, ...(text !== (data.canonicalText ?? data.text) ? { text } : {}) }),
              }).then((r) => {
                if (r.ok) onDone(row._id);
                else setErr('Stempel gagal — jika pesan sudah terkirim di WhatsApp, jangan kirim ulang; muat ulang halaman.');
              }).catch(() => {
                setErr('Jaringan bermasalah saat menandai — jika pesan sudah terkirim, jangan kirim ulang.');
              });
            }}
          >
            📱 Kirim manual (WhatsApp Web)
          </button>
          <button type="button" className="btn primary" disabled={!data || posting || waHandled(data) || draft.trim() === ''} onClick={() => void send()}>
            {posting ? <><span className="fb-spin fb-spin-w" /> Mengantre…</> : 'Kirim ke Customer'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Zero-setup bulk: no gateway, no robot, no pairing — the sender IS the
 * infrastructure. A stepper walks whoever is logged into WhatsApp (Web or
 * phone) through the selected cards one by one: each step opens the chat with
 * the full message pre-filled, they press send there, the doc is stamped
 * 'manual' (so no other sender ever duplicates it), and the next customer
 * loads. Bulk for humans: two taps per customer, zero installs.
 */
function BulkManualModal({ targets, onClose, onSent }: {
  targets: FlowRow[];
  onClose: () => void;
  onSent: (spkId: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [data, setData] = useState<WaPreview | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [failedMarks, setFailedMarks] = useState<string[]>([]);
  const [marking, setMarking] = useState(false);
  const row = idx < targets.length ? targets[idx] : null;

  useEffect(() => {
    if (!row) return;
    let live = true;
    setData(null);
    setErr(null);
    fetch(`/api/checkgo/${encodeURIComponent(row._id)}/alert`, { cache: 'no-store' })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!r.ok) { setErr(str(body.message) ?? 'Tidak bisa memuat pesan.'); return; }
        setData(body as unknown as WaPreview);
        setDraft((body as unknown as WaPreview).text);
      })
      .catch(() => { if (live) setErr('Jaringan bermasalah — coba lagi.'); });
    return () => { live = false; };
  }, [row]);

  async function openAndMark() {
    if (!row || !data || marking || waHandled(data) || draft.trim() === '') return;
    const text = draft;
    // The user's click is the gesture that lets this tab open — one per step,
    // so popup blockers stay quiet. A strict blocker still returns null, and
    // then nothing was sent: stamping would bury the customer, so refuse.
    const tab = window.open(`https://wa.me/${data.to}?text=${encodeURIComponent(text)}`, '_blank');
    if (tab === null) {
      setErr('Popup diblokir browser — izinkan popup untuk situs ini, lalu tekan tombol lagi.');
      return;
    }
    // Await the stamp before advancing: a failed stamp must be reported, not
    // counted as sent — the stamp is the only thing stopping a re-send.
    setMarking(true);
    try {
      const res = await fetch(`/api/checkgo/${encodeURIComponent(row._id)}/alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: 'flow-board-bulk-manual', manual: true, ...(text !== (data.canonicalText ?? data.text) ? { text } : {}) }),
      });
      if (res.ok) {
        onSent(row._id);
        setSentCount((n) => n + 1);
      } else {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setFailedMarks((s) => [...s, `${row.plate}: ${res.status === 409 ? 'sudah ditangani pengirim lain' : body.message ?? `HTTP ${res.status}`}`]);
      }
    } catch {
      setFailedMarks((s) => [...s, `${row.plate}: jaringan — stempel GAGAL walau chat sudah terbuka`]);
    }
    setMarking(false);
    setData(null); // cleared here, not in the effect — no stale-customer frame
    setErr(null);
    setIdx((i) => i + 1);
  }

  function skip() {
    if (marking) return;
    if (row) setSkipped((s) => [...s, row.plate]);
    setData(null);
    setErr(null);
    setIdx((i) => i + 1);
  }

  function safeClose() {
    if (!marking) onClose();
  }

  return (
    <div className="ovr-overlay" onClick={safeClose}>
      <div className="ovr-card" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        {row ? (
          <>
            <div className="fb-mtitle">Kirim manual — customer {idx + 1} dari {targets.length}</div>
            {err && <div className="fb-errchip" style={{ marginTop: 10 }}><div className="fb-errtxt">✗ {err}</div></div>}
            {!data && !err && <div className="fb-wait" style={{ marginTop: 10 }}><span className="fb-spin" /> Memuat pesan…</div>}
            {data && (
              <>
                <div className="fb-msub" style={{ marginTop: 8 }}>
                  <b>{data.profile.nama}</b> · {data.profile.wa ?? data.to} · {data.profile.plate} · {data.profile.branch}
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={8}
                  maxLength={4000}
                  disabled={marking}
                  style={{ display: 'block', width: '100%', marginTop: 10, padding: 10, background: 'var(--surface-2, #f4f6fb)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', lineHeight: 1.45, resize: 'vertical' }}
                />
                <div className="fb-mhint" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span>✏️ Pesan bisa diedit sebelum dikirim.</span>
                  {draft !== (data.canonicalText ?? data.text) && (
                    <button type="button" className="btn ghost" style={{ width: 'auto', padding: '3px 10px', fontSize: 12 }} onClick={() => setDraft(data.canonicalText ?? data.text)}>
                      ↺ Kembalikan asli
                    </button>
                  )}
                </div>
                {waHandled(data) && (
                  <div className="fb-errchip" style={{ marginTop: 10 }}>
                    <div className="fb-errtxt">
                      ⚠ Sudah ditangani ({data.status?.mode === 'live' ? 'terkirim gateway' : data.status?.mode === 'requested' ? 'antre gateway' : 'dikirim manual'}) —
                      mengirim lagi berarti customer menerima dua kali. <b>Lewati</b>.
                    </div>
                  </div>
                )}
                <div className="fb-mhint">
                  Tombol di bawah membuka WhatsApp dengan pesan sudah terisi —
                  tekan kirim di sana, lalu kembali ke tab ini untuk customer
                  berikutnya.
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn ghost" disabled={marking} onClick={safeClose}>Berhenti</button>
              <button type="button" className="btn ghost" disabled={marking} onClick={skip}>Lewati</button>
              <button type="button" className="btn primary" disabled={!data || marking || waHandled(data) || draft.trim() === ''} onClick={() => void openAndMark()}>
                {marking ? 'Menandai…' : '📱 Buka WhatsApp & tandai terkirim'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="fb-mtitle">Selesai</div>
            <div className="fb-msub" style={{ marginTop: 8 }}>
              ✓ {sentCount} pesan dibuka &amp; ditandai terkirim manual.
              {skipped.length > 0 && <><br />Dilewati: {skipped.join(', ')}</>}
            </div>
            {failedMarks.length > 0 && (
              <div className="fb-errchip" style={{ marginTop: 10 }}>
                <div className="fb-errtxt">
                  ⚠ Stempel gagal untuk: {failedMarks.join(' · ')} —
                  jika chat-nya sempat terbuka dan terkirim, JANGAN kirim ulang; cek riwayat chat pengirim.
                </div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="btn primary" onClick={onClose}>Tutup</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────────────────

function DocLink({ label, no, url }: { label: string; no: string | null; url: string | null }) {
  if (!no) return null;
  return (
    <span className="fb-doc">
      <span className="fb-doc-k">{label}</span>{' '}
      {url ? <a href={url} target="_blank" rel="noreferrer">{no}</a> : <span>{no}</span>}
    </span>
  );
}

function Card({ row, onAction, onRetry, onWa, onArchive, selectable, selected, onToggleSelect }: {
  row: FlowRow;
  onAction: (row: FlowRow, def: ActionDef) => void;
  onRetry: (row: FlowRow) => void;
  onWa: (row: FlowRow) => void;
  onArchive: (row: FlowRow) => void;
  /** Bulk-WA selection (Check & Go, belum terkirim) — checkbox kanan-atas. */
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const chip = stageChip(row);
  const def = nextActionFor(row);
  const pj = row.pendingJob;
  const inFlight = pj !== null && (pj.state === 'queued' || pj.state === 'running');
  const failed = pj !== null && pj.state === 'failed';
  const pjLabel = pj ? (ACTIONS[pj.action]?.label ?? pj.action) : '';
  const isCng = row.docType === 'CHECK_AND_GO';
  const col = row.column;
  // Edge case C&G: customer tidak setuju perbaikan → tetap check-only.
  const showStayCheck = isCng && col === 'wo' && row.wo?.status === 'in_progress' && !inFlight;

  return (
    <div className="fb-card">
      <div className="fb-card-top">
        <span className="fb-plate">{row.plate}</span>
        <span className={`badge ${isCng ? 'green' : 'blue'}`}>{isCng ? 'C&G' : 'SPK'}</span>
        {selectable && (
          <input
            type="checkbox"
            className="chk fb-selchk"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(row._id)}
            title="Pilih untuk kirim WA massal"
          />
        )}
      </div>
      <div className="fb-cust">{row.customer}</div>
      <div className="fb-meta">
        {row.branchCode}
        {row.total > 0 ? <> · {rp(row.total)}</> : null}
        {' '}· <span className={`badge ${chip.cls}`} style={{ fontSize: 10, padding: '1px 6px' }}>{chip.text}</span>
      </div>
      <div className="fb-docs">
        <DocLink label="SO" no={row.so?.no ?? null} url={row.so?.url ?? null} />
        <DocLink label="WO" no={row.wo?.no ?? null} url={row.wo?.url ?? null} />
        <DocLink label="INV" no={row.invoice?.no ?? null} url={row.invoice?.url ?? null} />
        {/* The captured intake rendered back onto its own paper — print/PDF.
            SPK docs get the SURAT PERINTAH KERJA layout, Check & Go docs the
            CHECK and GO REPORT (final 3) layout. */}
        <a
          className="fb-doc"
          href={`/${isCng ? 'checkgo' : 'spk'}/${encodeURIComponent(row._id)}/print`}
          target="_blank"
          rel="noreferrer"
          title={isCng ? 'Cetak Check & Go (format kertas)' : 'Cetak SPK (format kertas)'}
        >🖨</a>
        {/* Keluarkan dari papan — dokumen TIDAK dihapus, hanya diarsipkan. */}
        <button
          type="button"
          className="fb-doc fb-archbtn"
          title="Arsipkan — keluarkan dari papan (dokumen tetap tersimpan)"
          onClick={() => onArchive(row)}
        >🗄</button>
      </div>

      {/* Merged into the car's Check & Go order: say where the work went, and
          say what a human still has to do about it. These warnings used to live
          only in the worker's log, which nobody at the branch reads. */}
      {row.mergedIntoNo && (
        <div className="fb-meta" style={{ marginTop: 6 }}>
          ↪ Baris masuk ke SO {row.mergedIntoNo} — lanjutkan dari kartu {row.docType === 'CHECK_AND_GO' ? 'SPK' : 'Check & Go'} mobil ini.
          {row.mergeWarnings.map((w) => (
            <div key={w} style={{ marginTop: 4, color: '#b45309' }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Check & Go only: nothing reaches the customer's WhatsApp without this
          button — the drainer sends solely docs the modal stamped 'requested'. */}
      {isCng && (
        row.waAlert === 'live' ? (
          <div className="fb-meta" style={{ marginTop: 6, color: '#15803d' }}>✓ Hasil terkirim via WA</div>
        ) : row.waAlert === 'requested' ? (
          <div className="fb-meta" style={{ marginTop: 6 }}><span className="fb-spin" /> WA antre kirim…</div>
        ) : row.waAlert === 'manual' ? (
          <div className="fb-meta" style={{ marginTop: 6, color: '#15803d' }}>📱 WA dikirim manual</div>
        ) : row.waAlert === 'failed' ? (
          <div className="fb-meta" style={{ marginTop: 6, color: 'var(--muted)' }}>WA dilewati / gagal</div>
        ) : (
          <button type="button" className="btn ghost fb-act-sec" style={{ marginTop: 6 }} onClick={() => onWa(row)}>
            💬 Kirim Hasil via WA
          </button>
        )
      )}

      {inFlight && (
        <div className="fb-wait">
          <div><span className="fb-spin" /> {pj.state === 'running' ? 'Menjalankan' : 'Antri'}: {pjLabel}…</div>
          {/* A queued job that already failed once carries the retry reason —
              show it so a vendor outage never looks like a silent hang. */}
          {pj.error && (
            <div className="fb-waitwhy">
              {/maintenance/i.test(pj.error) ? '🛠 ' : '↻ '}
              {pj.error}
              {pj.attempts != null && pj.attempts > 0 ? ` (percobaan ${pj.attempts})` : ''}
            </div>
          )}
        </div>
      )}

      {failed && (
        <div className="fb-errchip" title={pj.error ?? undefined}>
          <div className="fb-errtxt">✗ {pjLabel} gagal{pj.error ? `: ${pj.error}` : ''}</div>
          <button type="button" className="fb-retry" onClick={() => onRetry(row)}>
            Coba lagi
          </button>
        </div>
      )}

      {!inFlight && !failed && def && (
        <button type="button" className="btn primary fb-act" onClick={() => onAction(row, def)}>{def.label}</button>
      )}
      {!inFlight && !failed && !def && col === 'intake' && (
        <div className="fb-wait" style={{ color: 'var(--muted)' }}><span className="fb-spin" /> Menunggu Service Order dari Turboly…</div>
      )}
      {/* Where the Approve SO button used to be. Without a word here the card
          reads as stuck; this says whose turn it is. */}
      {!inFlight && !failed && !def && col === 'so' && (
        <div className="fb-meta" style={{ marginTop: 6, color: 'var(--muted)' }}>
          Di-approve langsung di Turboly — buka tautan SO di atas.
        </div>
      )}
      {showStayCheck && !failed && (
        <button type="button" className="btn ghost fb-act-sec" onClick={() => onAction(row, ACTIONS.stay_check_only!)}>Tetap Check Saja</button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Board page
// ─────────────────────────────────────────────────────────────────────────

export default function FlowBoard() {
  const [rows, setRows] = useState<FlowRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [authErr, setAuthErr] = useState(false);
  const [netErr, setNetErr] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [branchFilter, setBranchFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'spk' | 'cng'>('all');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<{ row: FlowRow; def: ActionDef } | null>(null);
  const [waModal, setWaModal] = useState<FlowRow | null>(null);
  const [bulkManual, setBulkManual] = useState<FlowRow[] | null>(null);
  /** Bulk-WA multi-selection: spkIds of Check & Go cards ticked for send. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkSending, setBulkSending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The board asks six times a minute and the answer is usually identical, so
  // it carries the last ETag and lets the server reply 304 with no body. Held
  // in a ref rather than sent by the browser cache, because `cache: no-store`
  // (which this must keep, to defeat any intermediate cache) also suppresses
  // the automatic If-None-Match.
  const etagRef = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/flow/state', {
        cache: 'no-store',
        headers: etagRef.current ? { 'if-none-match': etagRef.current } : undefined,
      });
      if (res.status === 401 || res.status === 403) { setAuthErr(true); setLoaded(true); return; }
      // 304: the board is already showing this exact data. Only the "last
      // updated" clock moves, so the operator can still see polling is alive.
      if (res.status === 304) {
        setAuthErr(false); setNetErr(false); setLoaded(true);
        setUpdatedAt(new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        return;
      }
      const tag = res.headers.get('etag');
      if (tag) etagRef.current = tag;
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const raw = Array.isArray(body.rows) ? body.rows : [];
      const next: FlowRow[] = [];
      for (const r of raw) { const n = normRow(r); if (n) next.push(n); }
      setRows(next);
      setAuthErr(false);
      setNetErr(false);
      setUpdatedAt(new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch {
      setNetErr(true);
    }
    setLoaded(true);
  }, []);

  // Poll every 10s (skip while the tab is hidden; refresh on return).
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    const onVis = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // After a job is enqueued: optimistic spinner now, real state shortly after.
  const onActionDone = useCallback((spkId: string, action: string) => {
    setModal(null);
    setRows((prev) => prev.map((r) => (r._id === spkId ? { ...r, pendingJob: { jobId: null, action, state: 'queued', error: null, attempts: 0 } } : r)));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void load(); }, 1500);
  }, [load]);

  // Retry of a FAILED job: re-queue the SAME job via {retryJobId} — the
  // original params (mekanik, waktu, temuan, …) ride along unchanged. Only
  // when the job id is unknown does the params modal open again.
  const onRetry = useCallback((row: FlowRow) => {
    const pj = row.pendingJob;
    if (!pj || pj.state !== 'failed') return;
    if (!pj.jobId) {
      const def = ACTIONS[pj.action] ?? { action: pj.action, label: pj.action, fields: 'none' as const, hint: 'Ulangi aksi yang gagal.' };
      setModal({ row, def });
      return;
    }
    const jobId = pj.jobId;
    setRows((prev) => prev.map((r) => (r._id === row._id ? { ...r, pendingJob: { ...pj, state: 'queued', error: null } } : r)));
    void (async () => {
      try {
        const res = await fetch('/api/flow/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ retryJobId: jobId }),
        });
        if (!res.ok) void load(); // e.g. job no longer failed — resync the board
      } catch {
        void load();
      }
    })();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void load(); }, 1500);
  }, [load]);

  // Archive: keluarkan dari papan (dokumen tetap tersimpan) — alasan wajib.
  const onArchive = useCallback((row: FlowRow) => {
    const reason = prompt('Alasan arsip? (wajib — tercatat pada dokumen)');
    if (!reason || reason.trim() === '') return;
    void (async () => {
      try {
        const res = await fetch(`/api/spk/${encodeURIComponent(row._id)}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim(), by: 'flow-board' }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          alert(str(body.message) ?? str(body.error) ?? `Gagal mengarsipkan (HTTP ${res.status})`);
          return;
        }
        // Optimistic: the card leaves the board now; the poll confirms.
        setRows((prev) => prev.filter((r) => r._id !== row._id));
        setSelected((prev) => {
          if (!prev.has(row._id)) return prev;
          const next = new Set(prev);
          next.delete(row._id);
          return next;
        });
      } catch {
        alert('Jaringan bermasalah — coba lagi.');
      }
    })();
  }, []);

  /** Eligible for bulk WA: same gate as the single "Kirim Hasil via WA" button. */
  const waEligible = useCallback(
    (r: FlowRow) => r.docType === 'CHECK_AND_GO' && r.waAlert === null,
    [],
  );

  // Every poll re-validates the ticks: a row someone else queued or sent must
  // fall out of the selection, or a stale bulk click re-stamps it (erasing a
  // colleague's queued edit, or double-messaging an already-served customer).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ok = new Set(rows.filter(waEligible).map((r) => r._id));
      const next = new Set([...prev].filter((id) => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows, waEligible]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Bulk WA: stamp each selected doc 'requested' SEQUENTIALLY (the gateway
  // watcher delivers later) — exactly what WaModal does, just for many cards.
  const onBulkWa = useCallback(async () => {
    if (bulkSending) return;
    const targets = rows.filter((r) => selected.has(r._id));
    if (targets.length === 0) return;
    const listing = targets.map((r) => `${r.plate} — ${r.customer}`).join('\n');
    const ok = confirm(
      `Kirim hasil Check & Go via WhatsApp ke ${targets.length} customer?\n\n${listing}\n\nPesan dikirim otomatis oleh gateway (±30 dtk per antrean).`,
    );
    if (!ok) return;
    setBulkSending(true);
    const okIds: string[] = [];
    const fails: string[] = [];
    for (const r of targets) {
      try {
        const res = await fetch(`/api/checkgo/${encodeURIComponent(r._id)}/alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by: 'flow-board-bulk' }),
        });
        if (res.ok) {
          okIds.push(r._id);
        } else {
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const reason =
            res.status === 409 ? 'sudah pernah terkirim'
            : str(body.message) ?? str(body.error) ?? `HTTP ${res.status}`;
          fails.push(`${r.plate}: ${reason}`);
        }
      } catch {
        fails.push(`${r.plate}: jaringan bermasalah`);
      }
    }
    alert(
      `Terkirim ke antrean: ${okIds.length} — Gagal: ${fails.length}` +
      (fails.length > 0 ? `\n${fails.join('\n')}` : ''),
    );
    if (okIds.length > 0) {
      const okSet = new Set(okIds);
      setRows((prev) => prev.map((r) => (okSet.has(r._id) ? { ...r, waAlert: 'requested' } : r)));
    }
    setSelected(new Set());
    setBulkSending(false);
  }, [bulkSending, rows, selected]);

  const branches = useMemo(() => [...new Set(rows.map((r) => r.branchCode).filter((b) => b !== ''))].sort(), [rows]);

  const filtered = useMemo(() => {
    const qq = q.trim().toUpperCase();
    return rows.filter((r) => {
      if (branchFilter && r.branchCode !== branchFilter) return false;
      if (typeFilter === 'spk' && r.docType === 'CHECK_AND_GO') return false;
      if (typeFilter === 'cng' && r.docType !== 'CHECK_AND_GO') return false;
      if (qq && !r.plate.toUpperCase().includes(qq) && !r.customer.toUpperCase().includes(qq)) return false;
      return true;
    });
  }, [rows, branchFilter, typeFilter, q]);

  const byCol = useMemo(() => {
    const m: Record<ColKey, FlowRow[]> = { intake: [], so: [], wo: [], qc: [], invoice: [], done: [] };
    for (const r of filtered) m[r.column].push(r);
    return m;
  }, [filtered]);

  const failedCount = useMemo(() => filtered.filter((r) => r.pendingJob?.state === 'failed').length, [filtered]);

  return (
    <>
      <style>{`
        .fb-page { max-width: 1500px; margin: 0 auto; padding: 12px 14px 30px; }
        .fb-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
        .fb-toolbar select, .fb-toolbar input { width: auto; font-size: 13px; padding: 7px 10px; border-radius: 8px; }
        .fb-tf { display: flex; gap: 4px; }
        .fb-tf button { font-size: 12px; font-weight: 600; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: #fff; cursor: pointer; color: #55627a; }
        .fb-tf button.on { border-color: var(--nawilis); background: var(--nawilis-tint); color: var(--nawilis); }
        .fb-upd { margin-left: auto; font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
        .fb-upd button { font-size: 12px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; cursor: pointer; }
        .fb-board { display: flex; gap: 10px; overflow-x: auto; align-items: flex-start; padding-bottom: 20px; -webkit-overflow-scrolling: touch; }
        .fb-col { flex: 0 0 236px; min-width: 236px; background: #e7ecf5; border: 1px solid #d6ddea; border-radius: 12px; padding: 8px; }
        .fb-col-h { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase; color: var(--nawilis); padding: 2px 4px 6px; }
        .fb-count { background: #fff; border: 1px solid var(--line); border-radius: 999px; font-size: 11px; font-weight: 700; padding: 0 8px; color: #55627a; }
        .fb-empty { border: 1.5px dashed #c4cede; border-radius: 10px; text-align: center; color: #9aa6ba; font-size: 12px; padding: 14px 0; }
        .fb-card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(30,46,145,.07); font-size: 13px; }
        .fb-card-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
        .fb-plate { font-weight: 800; font-size: 14.5px; letter-spacing: .3px; }
        .fb-cust { font-size: 12.5px; color: #33415c; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fb-meta { font-size: 11px; color: var(--muted); margin-top: 3px; }
        .fb-docs { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; font-size: 11.5px; }
        .fb-docs:empty { display: none; }
        .fb-doc-k { color: var(--muted); font-weight: 700; font-size: 10px; }
        .fb-doc a { color: var(--nawilis-2); text-decoration: none; font-weight: 600; }
        .fb-doc a:hover { text-decoration: underline; }
        .fb-act { width: 100%; margin-top: 9px; font-size: 13.5px; font-weight: 700; padding: 9px 10px; border-radius: 9px; }
        .fb-act-sec { width: 100%; margin-top: 6px; font-size: 12px; font-weight: 600; padding: 7px 10px; border-radius: 9px; }
        .fb-wait { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--nawilis-2); margin-top: 9px; }
        .fb-spin { width: 13px; height: 13px; flex: none; border: 2px solid #c9d7f0; border-top-color: var(--nawilis-2); border-radius: 50%; display: inline-block; animation: fbspin .8s linear infinite; }
        .fb-spin-w { border-color: rgba(255,255,255,.35); border-top-color: #fff; vertical-align: -2px; margin-right: 6px; }
        @keyframes fbspin { to { transform: rotate(360deg); } }
        .fb-errchip { background: #fdecea; border: 1px solid #f3c1bd; border-radius: 9px; padding: 7px 9px; margin-top: 9px; }
        .fb-errtxt { color: var(--block); font-size: 11.5px; line-height: 1.4; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .fb-retry { margin-top: 6px; font-size: 12px; font-weight: 700; padding: 5px 12px; border: 1.5px solid var(--block); border-radius: 8px; background: #fff; color: var(--block); cursor: pointer; }
        .fb-retry:active { background: #fdecea; }
        .fb-archbtn { border: 0; background: none; padding: 0; cursor: pointer; font-size: inherit; line-height: inherit; }
        .fb-archbtn:hover { filter: brightness(.85); }
        .fb-selchk { margin-left: 2px; width: 16px; height: 16px; flex: none; cursor: pointer; accent-color: var(--nawilis); }
        .fb-bulkbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 60; display: flex; gap: 10px; justify-content: center; align-items: center; padding: 12px 16px; background: #fff; border-top: 1px solid var(--line); box-shadow: 0 -4px 16px rgba(30,46,145,.14); }
        .fb-bulkbar .btn { width: auto; }
        .fb-mtitle { font-size: 17px; font-weight: 900; color: var(--nawilis); }
        .fb-msub { font-size: 12.5px; color: #33415c; margin-top: 4px; }
        .fb-mhint { font-size: 12px; color: var(--muted); margin-top: 6px; }
      `}</style>

      <div className="topbar">
        <BrandMark page="FLOW" />
        <span className="branch">{filtered.length} dokumen aktif{failedCount > 0 ? ` · ${failedCount} gagal` : ''}</span>
      </div>

      <div className="fb-page">
        <div className="fb-toolbar">
          <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
            <option value="">Semua cabang</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <div className="fb-tf">
            {([['all', 'Semua'], ['spk', 'SPK'], ['cng', 'C&G']] as const).map(([k, label]) => (
              <button key={k} type="button" className={typeFilter === k ? 'on' : ''} onClick={() => setTypeFilter(k)}>{label}</button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari plat / nama…" style={{ minWidth: 160 }} />
          <a href="/alerts" style={{ fontSize: 13, textDecoration: 'none', color: 'var(--nawilis)', whiteSpace: 'nowrap', alignSelf: 'center' }}>📋 Riwayat WA</a>
          <div className="fb-upd">
            {netErr ? <span style={{ color: 'var(--block)' }}>⚠ koneksi bermasalah</span> : updatedAt ? <span>Diperbarui {updatedAt}</span> : null}
            <button type="button" onClick={() => void load()} title="Muat ulang sekarang">↻</button>
          </div>
        </div>

        {authErr && (
          <div className="card">
            <div className="finding BLOCK">Sesi berakhir — silakan <a href="/login">login</a> ulang untuk melihat papan flow.</div>
          </div>
        )}

        {!authErr && loaded && rows.length === 0 && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--muted)' }}>
            Belum ada dokumen aktif. Buat dari <a href="/">form SPK</a> atau <a href="/checkgo">Check &amp; Go</a>.
          </div>
        )}

        {!authErr && !loaded && (
          <div className="fb-wait" style={{ justifyContent: 'center', padding: 30 }}><span className="fb-spin" /> Memuat papan flow…</div>
        )}

        {!authErr && loaded && rows.length > 0 && (
          <div className="fb-board">
            {COLUMNS.map((c) => (
              <div key={c.key} className="fb-col">
                <div className="fb-col-h">
                  <span>{c.label}</span>
                  <span className="fb-count">{byCol[c.key].length}</span>
                </div>
                {byCol[c.key].length === 0 && <div className="fb-empty">—</div>}
                {byCol[c.key].map((r) => (
                  <Card
                    key={r._id}
                    row={r}
                    onAction={(row, def) => setModal({ row, def })}
                    onRetry={onRetry}
                    onWa={setWaModal}
                    onArchive={onArchive}
                    selectable={waEligible(r)}
                    selected={selected.has(r._id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="sync" style={{ marginTop: 6, textAlign: 'center', color: 'var(--muted)' }}>
          <a href="/">Form SPK</a>{' · '}<a href="/checkgo">Check &amp; Go</a>{' · '}<a href="/customers">Daftar customer</a>{' · '}<a href="/admin">Dashboard</a>
        </div>

        {/* Bulk-WA action bar — visible only while cards are ticked. */}
        {selected.size > 0 && (
          <div className="fb-bulkbar">
            <button type="button" className="btn primary" style={{ width: 'auto' }} disabled={bulkSending} onClick={() => void onBulkWa()}>
              {bulkSending
                ? <><span className="fb-spin fb-spin-w" /> Mengantre…</>
                : `💬 Kirim WA ke ${selected.size} customer`}
            </button>
            {/* Zero-setup bulk: no gateway needed — a stepper opens each chat
                on plain WhatsApp Web and the person presses send. */}
            <button
              type="button"
              className="btn ghost"
              disabled={bulkSending}
              onClick={() => setBulkManual(rows.filter((r) => selected.has(r._id)))}
            >
              📱 Manual satu-satu
            </button>
            <button type="button" className="btn ghost" disabled={bulkSending} onClick={() => setSelected(new Set())}>
              Batal
            </button>
          </div>
        )}
      </div>

      {modal && (
        <ActionModal
          row={modal.row}
          def={modal.def}
          onClose={() => setModal(null)}
          onDone={onActionDone}
        />
      )}

      {bulkManual && (
        <BulkManualModal
          targets={bulkManual}
          onClose={() => { setBulkManual(null); setSelected(new Set()); }}
          onSent={(id) => setRows((prev) => prev.map((r) => (r._id === id ? { ...r, waAlert: 'manual' } : r)))}
        />
      )}

      {waModal && (
        <WaModal
          row={waModal}
          onClose={() => setWaModal(null)}
          onDone={(spkId) => {
            // Optimistic 'requested' now; the poll confirms (and later flips
            // to 'live' once the drainer delivers).
            setWaModal(null);
            setRows((prev) => prev.map((r) => (r._id === spkId ? { ...r, waAlert: 'requested' } : r)));
          }}
        />
      )}
    </>
  );
}
