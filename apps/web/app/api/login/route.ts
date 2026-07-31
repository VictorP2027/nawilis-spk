import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/login {password} — sets the staff session cookie if it matches. */
export async function POST(req: Request): Promise<Response> {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  const expected = process.env.STAFF_PASSWORD;
  if (!expected || password !== expected) {
    return NextResponse.json({ error: 'wrong_password' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('spk_auth', process.env.SPK_SESSION_SECRET ?? 'dev-session', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
