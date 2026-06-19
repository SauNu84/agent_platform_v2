/**
 * Auth gate (edge): redirect unauthenticated requests to /login.
 *
 * This is a cheap cookie-presence check only — full validation (token lookup,
 * expiry, role/capability resolution) happens per-request in getActor() (Node
 * runtime). A present-but-invalid cookie still reaches a page, which then
 * redirects via requirePageActor(); API routes return 401. Public paths (the
 * login screen and the auth API) are allow-listed so the user can get in.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/auth/constants';

// Public, unauthenticated paths: the login screen, the auth API, the legal
// pages linked from the login footer (Terms / AUP / Privacy — SAU-234), and the
// Twilio telephony webhooks (SAU-270), and the Proviso marketing landing page
// (SAU-349). The telephony webhooks carry no session cookie — they authenticate
// via the `X-Twilio-Signature` HMAC verified inside the route, so they must
// bypass the cookie gate or no inbound call could ever connect. The Proviso
// landing page is the public front door for prospective design partners, who
// are by definition not logged in — gating it behind /login would defeat it.
const PUBLIC_PREFIXES = ['/login', '/api/auth', '/terms', '/privacy-policy', '/api/telephony', '/proviso'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  // API → 401 JSON; pages → redirect to /login (preserving intended path).
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals and static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
