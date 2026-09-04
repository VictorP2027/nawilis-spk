import { NextResponse } from 'next/server';
import { REF_BRANCHES, collections } from '@spk/core';
import { db } from '../../../../lib/db';
import { triggerBranchAdd } from '../../../../lib/triggerBranchAdd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/branch-add — open a branch from the app instead of GitHub.
 *
 * Behind the same staff-login cookie as every other page (middleware), so the
 * person who already signs in to write an SPK can do this too, and nobody
 * needs repo access.
 *
 * The real work still happens in the branch-add workflow: mapping the Turboly
 * store needs a browser, which this runtime does not have. So this validates
 * hard FIRST — a bad code reaching the workflow costs a minute and a confusing
 * log — then dispatches, and answers with what the operator should do next.
 */

const TYPES = new Set(['NAWILIS', 'QUICKSERV', 'COMPANY']);

/**
 * Free text, but not ARBITRARY text.
 *
 * These two values become arguments of a shell command in the workflow. That
 * step is hardened to read them from env rather than splice them into the
 * script, so this regex is the second lock, not the only one — but it is the
 * lock nearest the door, and the one that also keeps a stray paste out of a
 * branch name. Letters, digits, spaces and the punctuation a real branch or
 * store name uses. No quotes, backslash, backtick, $, ;, |, &, <, >, and no
 * line breaks.
 */
const SAFE_TEXT = /^[\p{L}\p{N} .,'()\/-]{1,60}$/u;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  const store = String(body.store ?? '').trim();
  const type = String(body.type ?? 'NAWILIS').trim().toUpperCase();
  const abbrev = String(body.abbrev ?? '').trim().toUpperCase();
  const noTurboly = body.no_turboly === true || body.no_turboly === 'true';

  const bad = (error: string, hint?: string): Response =>
    NextResponse.json({ error, hint }, { status: 400 });

  if (!code) return bad('Kode cabang wajib diisi.');
  if (!/^[A-Z0-9-]{3,12}$/.test(code)) {
    return bad(`Kode "${code}" tidak wajar.`, 'Huruf besar, angka dan tanda hubung saja, 3–12 karakter. Contoh: NWL-JKT');
  }
  if (!name) return bad('Nama cabang wajib diisi.', 'Ini yang muncul di pilihan cabang pada form.');
  if (!SAFE_TEXT.test(name)) {
    return bad('Nama cabang memuat karakter yang tidak diizinkan.', "Huruf, angka, spasi dan . , ' ( ) / - saja, maksimal 60 karakter.");
  }
  if (!TYPES.has(type)) return bad(`Jenis cabang "${type}" tidak dikenal.`, 'Pilih NAWILIS, QUICKSERV atau COMPANY.');
  if (!noTurboly && !store) {
    return bad('Nama store Turboly wajib diisi.', 'Salin persis dari dropdown Store di Turboly — atau centang "store belum ada di Turboly".');
  }
  // Checked even when the box is ticked: the value is forwarded either way.
  if (store && !SAFE_TEXT.test(store)) {
    return bad('Nama store memuat karakter yang tidak diizinkan.', "Huruf, angka, spasi dan . , ' ( ) / - saja, maksimal 60 karakter.");
  }
  if (abbrev && !/^[A-Z0-9]{1,6}$/.test(abbrev)) {
    return bad(`Singkatan "${abbrev}" tidak wajar.`, 'Huruf/angka saja, maksimal 6. Contoh: JKT. Boleh dikosongkan.');
  }

  // A shipped branch is never redefined from here — same rule the workflow
  // enforces, checked early so the operator hears it now instead of reading a
  // failed run. (Mongo is consulted for branches added earlier the same way.)
  const builtIn = REF_BRANCHES.find((b) => b.code === code);
  if (builtIn) {
    return NextResponse.json(
      { error: `${code} sudah dipakai cabang "${builtIn.name}".`, hint: 'Kode cabang tidak bisa dipakai ulang — semua SPK lama tercatat di bawah kode itu.' },
      { status: 409 },
    );
  }
  // A branch already in the picker is NOT a reason to refuse: the whole point
  // of the "store belum ada di Turboly" path is to come back later and finish
  // it, and a half-opened branch is exactly the one someone needs to re-run.
  // Refuse only what is genuinely already done — in the picker AND mapped to a
  // Turboly store — because that is the case where re-running would just spend
  // a minute to change nothing.
  let resuming = false;
  try {
    await db();
    const [existing, mapped] = await Promise.all([
      collections.branches().findOne({ _id: code }),
      collections.tbStores().findOne({ _id: code }),
    ]);
    if (existing && mapped) {
      return NextResponse.json(
        {
          error: `${code} sudah dibuka dan sudah terhubung ke store Turboly "${mapped.turbolyStoreName}".`,
          hint: 'Tidak perlu dijalankan lagi. Kalau advisor-nya belum muncul, daftarkan orangnya di Turboly (Setup → Users) lalu hubungi admin.',
        },
        { status: 409 },
      );
    }
    resuming = Boolean(existing);
  } catch {
    // A database hiccup must not block opening a branch: the workflow itself
    // re-checks both rules before it writes anything.
  }

  const res = await triggerBranchAdd({ code, name, store, type, abbrev, no_turboly: noTurboly });
  if (!res.ok) return NextResponse.json({ error: res.error, hint: res.hint }, { status: res.status });

  // "Accepted", not "done": all GitHub has promised is that the run is queued.
  // The branch is only real once the run finishes, and it can still stop on a
  // store name that does not match — so the wording, and the page, say queued.
  return NextResponse.json({
    ok: true,
    queued: true,
    resuming,
    code,
    name,
    runsUrl: `https://github.com/${process.env.GH_REPO ?? 'VictorP2027/nawilis-spk'}/actions/workflows/branch-add.yml`,
  });
}
