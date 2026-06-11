import Link from 'next/link';
import { LEGAL_COMPANY } from '@/lib/legal';

// Footer shown on the login page: Terms, Acceptable Use Policy, Privacy Policy.
// The AUP link deep-links to Terms §9 (the Acceptable Use Policy section).
export default function LegalFooter() {
  const year = 2026;
  return (
    <footer className="legal-footer">
      <nav>
        <Link href="/terms">Terms</Link>
        <span aria-hidden>·</span>
        <Link href="/terms#acceptable-use-policy">Acceptable Use Policy</Link>
        <span aria-hidden>·</span>
        <Link href="/privacy-policy">Privacy Policy</Link>
      </nav>
      <p className="legal-copyright">
        © {year} {LEGAL_COMPANY}
      </p>
    </footer>
  );
}
