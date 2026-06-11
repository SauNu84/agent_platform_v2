import Link from 'next/link';
import { LegalDoc, LEGAL_LAST_UPDATED, LEGAL_STATUS } from '@/lib/legal';

// Shared renderer for legal/policy pages (Privacy Policy, Terms, AUP). Styled
// with the platform's CSS tokens (globals.css) so it tracks light/dark theme.
export default function LegalDocView({ doc }: { doc: LegalDoc }) {
  return (
    <article className="legal-doc">
      <Link href="/login" className="legal-back">
        ← Back to sign in
      </Link>

      {LEGAL_STATUS === 'draft' && (
        <div className="legal-draft" role="note">
          <strong>Draft — pending legal review.</strong> This placeholder structure is
          awaiting authoritative copy from Legal/CISO and is not binding.
        </div>
      )}

      <h1>{doc.title}</h1>
      <p className="legal-updated">Last updated: {LEGAL_LAST_UPDATED}</p>
      <p className="legal-intro">{doc.intro}</p>

      <div className="legal-sections">
        {doc.sections.map((section) => (
          <section key={section.id} id={section.id} className="legal-section">
            <h2>{section.heading}</h2>
            {section.body.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}
