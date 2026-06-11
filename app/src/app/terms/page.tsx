import type { Metadata } from 'next';
import LegalDocView from '@/components/LegalDocView';
import { TERMS_OF_SERVICE, LEGAL_COMPANY } from '@/lib/legal';

export const metadata: Metadata = {
  title: `Terms of Service · ${LEGAL_COMPANY}`,
};

export default function TermsPage() {
  return <LegalDocView doc={TERMS_OF_SERVICE} />;
}
