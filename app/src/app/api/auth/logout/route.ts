/**
 * POST /api/auth/logout — revoke the server session + clear the cookie.
 * Idempotent; always 200. Public (allow-listed in middleware) so a stale/expired
 * cookie can still be cleared.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { logout } from '@/auth/session';
import { SESSION_COOKIE } from '@/auth/constants';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await logout(getStore(), token);
    } catch {
      /* best-effort revoke; clear the cookie regardless */
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
