/**
 * Login screen (public — allow-listed in middleware). Resolves the post-login
 * destination from `?next=` and renders the client form.
 */
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = typeof searchParams.next === 'string' ? searchParams.next : '/';
  return (
    <div className="login-wrap">
      <LoginForm next={next} />
    </div>
  );
}
