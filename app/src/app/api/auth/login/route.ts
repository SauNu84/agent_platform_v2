/**
 * POST /api/auth/login — email + password → server session + httpOnly cookie.
 * Body: { email, password }. 200 + sets the session cookie on success; 401 on
 * bad credentials; 400 on a malformed body. Public (allow-listed in middleware).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { login } from '@/auth/session';
import { SESSION_COOKIE } from '@/auth/constants';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email.trim() || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const session = await login(getStore(), email, password);
  if (!session) {
    return NextResponse.json({ error: 'invalid email or password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(session.expiresAt),
  });
  return res;
}
