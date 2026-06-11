'use client';

/**
 * Login form (Slice 5). Posts credentials to /api/auth/login; on success the
 * server sets the httpOnly session cookie and we navigate to `next`.
 *
 * Per board direction (SAU-234) the login screen shows NO user information
 * (the seeded test-user credential hint was removed); seeded test accounts are
 * documented in the README for QA instead.
 */
import { useState } from 'react';

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.href = next || '/';
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'login failed');
    } catch {
      setError('network error — please try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-card" onSubmit={onSubmit}>
      <h1>Sign in</h1>
      <p className="subtitle">Practice high-stakes conversations.</p>

      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      {error && <p className="notice" role="alert">{error}</p>}

      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
