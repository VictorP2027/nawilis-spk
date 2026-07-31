import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Staff-login gate. Everything requires a valid `spk_auth` cookie except the
 * login page + login API. Pages redirect to /login; API calls get 401.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname === '/login' || pathname.startsWith('/api/login')) return NextResponse.next();

  const token = req.cookies.get('spk_auth')?.value;
  if (token && token === process.env.SPK_SESSION_SECRET) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Protect everything except Next internals + PWA assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js).*)'],
};
