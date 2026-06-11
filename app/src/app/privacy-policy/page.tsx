import type { Metadata } from 'next';
import LegalDocView from '@/components/LegalDocView';
import { PRIVACY_POLICY, LEGAL_COMPANY } from '@/lib/legal';

export const metadata: Metadata = {
  title: `Privacy Policy · ${LEGAL_COMPANY}`,
};

export default function PrivacyPolicyPage() {
  return <LegalDocView doc={PRIVACY_POLICY} />;
}
