/**
 * Login screen (public — allow-listed in middleware). Resolves the post-login
 * destination from `?next=` and renders the client form. A legal footer
 * (Terms · Acceptable Use Policy · Privacy Policy) sits beneath the card per
 * board direction (SAU-234).
 */
import LoginForm from './LoginForm';
import LegalFooter from '@/components/LegalFooter';

export const dynamic = 'force-dynamic';

export default function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = typeof searchParams.next === 'string' ? searchParams.next : '/';
  return (
    <div className="login-wrap">
      <LoginForm next={next} />
      <LegalFooter />
    </div>
  );
}
