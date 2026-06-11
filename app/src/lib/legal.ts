// Single source of truth for legal/policy content surfaced from the login page.
//
// PROVENANCE: the policy BODY text below is the CISO/Legal-approved copy authored
// and ratified under SAU-235 (CISO review 2026-06-11). It is ported here VERBATIM
// from its authoring location into agent_platform_v2 — the correct project for the
// Tough Tongue AI POC login page (SAU-234). Do not edit the policy body without a
// CISO re-review; bump LEGAL_LAST_UPDATED on any substantive change.
//
// Scope of the CISO approval — what was actually verified:
//   • The data-handling, retention/erasure, security, and sub-processor
//     REPRESENTATIONS below are accurate and grounded in the platform's real
//     practices ratified in the SECURITY-REVIEW §6.0/§6.1 (no PAN stored /
//     Stripe sub-processor, 7yr US-ROW & 10yr EU financial-records retention
//     floor then PII minimization, 30-day erasure SLA, TLS, secret management,
//     forced multi-tenant RLS / NOBYPASSRLS tenant isolation — the RLS posture
//     is live in this repo via migrations 0006/0007 + the app_rw role).
//   • The Acceptable Use Policy (Terms §9) covers the security-relevant abuse
//     classes (unauthorized access, DoS, malware, scraping, reverse
//     engineering).
//
// What this approval is NOT: a CISO security/privacy content review, not a
// licensed-attorney legal opinion. Before opening to real external users (GA),
// two items must close — tracked as pre-GA conditions (SAU-236):
//   (1) Name the operating legal entity + governing-law jurisdiction in
//       Terms §12 and the Privacy controller line (currently generic).
//   (2) Qualified-counsel review of the ToS liability / IP / arbitration
//       clauses.
//
// Adapted from our canonical published references:
//   https://app.toughtongueai.com/privacy-policy/
//   https://app.toughtongueai.com/terms/
//   https://app.toughtongueai.com/terms/#9-acceptable-use-policy

export const LEGAL_COMPANY = 'Tough Tongue AI';
export const LEGAL_CONTACT = 'privacy@toughtongueai.com';

// 'approved' removes the "pending legal review" draft banner. Cleared by
// CISO/Legal under SAU-235.
export const LEGAL_STATUS: 'draft' | 'approved' = 'approved';

// Effective date of the authoritative copy (CISO/Legal approval, SAU-235).
export const LEGAL_LAST_UPDATED = '2026-06-11';

export interface LegalSection {
  id: string;
  heading: string;
  body: string[];
}

export interface LegalDoc {
  slug: string;
  title: string;
  intro: string;
  sections: LegalSection[];
}

export const PRIVACY_POLICY: LegalDoc = {
  slug: 'privacy-policy',
  title: 'Privacy Policy',
  intro: `This Privacy Policy explains how ${LEGAL_COMPANY} ("we", "us", "our") collects, uses, shares, and protects personal information when you use our platform and related services. We are the controller of the personal data described below. By using the platform you agree to the practices described here.`,
  sections: [
    {
      id: 'information-we-collect',
      heading: '1. Information We Collect',
      body: [
        'Account and identity information you provide directly, such as your email address, display name, and the authentication credentials or identity-provider details used to sign in (including via single sign-on, OAuth, or magic link).',
        'Organization and invitation data, including the email addresses of people invited to an organization workspace and your role and membership within an organization.',
        'Content you generate while using the service, including practice sessions and conversation transcripts. These may contain personal information depending on what you choose to discuss.',
        'Billing information limited to subscription status, plan, amounts, and opaque payment references. We do not collect or store full payment card numbers (PAN); card details are handled directly by our payment processor.',
        'Usage, diagnostic, and security data generated as you interact with the platform, such as log and event records, device and browser information, and audit metadata about actions taken in your organization.',
      ],
    },
    {
      id: 'how-we-use-information',
      heading: '2. How We Use Your Information',
      body: [
        'To provide, operate, secure, and improve the platform and its features.',
        'To authenticate you, manage organization membership and access, and process subscriptions and payments.',
        'To communicate with you about your account, security notices, and material changes to the service or these policies.',
        'To detect, investigate, and prevent fraud, abuse, and security incidents, and to comply with our legal obligations.',
      ],
    },
    {
      id: 'legal-bases',
      heading: '3. Legal Bases for Processing',
      body: [
        'Where the GDPR or similar laws apply, we process personal data on the following bases: performance of our contract with you (to provide the service); our legitimate interests (to secure, maintain, and improve the platform and prevent abuse); compliance with legal obligations (including financial-records and tax retention); and your consent where required.',
        'You may withdraw consent at any time where processing is based on consent, without affecting processing already carried out.',
      ],
    },
    {
      id: 'how-we-share-information',
      heading: '4. How We Share Information',
      body: [
        'We share personal data with service providers (sub-processors) who process it on our behalf under contract, including our payment processor (Stripe) for billing, and our email and identity-provider partners for authentication and notifications.',
        'We may disclose information where required by law, to enforce our Terms, or to protect the rights, safety, and security of our users, the public, or our platform.',
        'If we are involved in a merger, acquisition, or sale of assets, personal data may be transferred as part of that transaction, subject to this Policy.',
        'We do not sell personal data.',
      ],
    },
    {
      id: 'data-retention',
      heading: '5. Data Retention',
      body: [
        'We retain personal data only for as long as necessary to provide the service and for the purposes described in this Policy, after which it is deleted or de-identified.',
        'Financial and payment records are retained for the minimum period required by applicable law before any personal data they contain is minimized — generally seven (7) years for United States and rest-of-world records and ten (10) years for European Union records. We retain these records to meet legal obligations and to establish, exercise, or defend legal claims.',
        'When data reaches the end of its retention period, or upon a valid erasure request, we remove or de-identify the associated personal information (for example, by nulling email and display name) while preserving immutable financial records as the law requires.',
      ],
    },
    {
      id: 'your-rights',
      heading: '6. Your Privacy Rights',
      body: [
        'Subject to applicable law, you may request to access, correct, export (portability), or delete your personal data, and you may object to or restrict certain processing.',
        'We fulfill verified erasure and access requests within thirty (30) days. Some data may be retained where we have a legal obligation or an overriding legitimate basis to keep it (such as financial records within their statutory retention period).',
        'To exercise your rights, contact us at the address below. You also have the right to lodge a complaint with your local data protection authority.',
      ],
    },
    {
      id: 'data-security',
      heading: '7. Data Security',
      body: [
        'We protect data in transit and at rest using industry-standard safeguards, including TLS encryption end-to-end, strict secret management, least-privilege access controls, tenant isolation that prevents one organization from accessing another’s data, and audit logging of sensitive actions.',
        'No method of transmission or storage is perfectly secure. We maintain an incident-response process and will notify affected users and regulators of qualifying incidents as required by law.',
      ],
    },
    {
      id: 'international-transfers',
      heading: '8. International Data Transfers',
      body: [
        'We may process and store data in countries other than where you reside. Where we transfer personal data internationally, we rely on appropriate safeguards such as Standard Contractual Clauses or an equivalent lawful transfer mechanism.',
      ],
    },
    {
      id: 'childrens-privacy',
      heading: "9. Children's Privacy",
      body: [
        'The platform is not directed to children under the age of 16 (or the minimum age required in your jurisdiction), and we do not knowingly collect their personal data. If you believe a child has provided us personal data, contact us and we will delete it.',
      ],
    },
    {
      id: 'changes',
      heading: '10. Changes to This Policy',
      body: [
        'We may update this Privacy Policy from time to time. When we make material changes we will update the "Last updated" date and, where appropriate, provide additional notice. Your continued use of the platform after an update constitutes acceptance of the revised Policy.',
      ],
    },
    {
      id: 'contact',
      heading: '11. Contact Us',
      body: [
        `If you have questions about this Privacy Policy or wish to exercise your privacy rights, contact us at ${LEGAL_CONTACT}.`,
      ],
    },
  ],
};

export const TERMS_OF_SERVICE: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  intro: `These Terms of Service ("Terms") govern your access to and use of the ${LEGAL_COMPANY} platform and related services. By accessing or using the platform, you agree to be bound by these Terms. If you are using the platform on behalf of an organization, you represent that you are authorized to bind that organization.`,
  sections: [
    {
      id: 'acceptance',
      heading: '1. Acceptance of Terms',
      body: [
        'By accessing or using the platform you agree to these Terms and to our Privacy Policy, which is incorporated by reference. If you do not agree, do not use the platform.',
      ],
    },
    {
      id: 'eligibility-accounts',
      heading: '2. Eligibility and Accounts',
      body: [
        'You must be at least 16 years old (or the minimum age of digital consent in your jurisdiction) and able to form a binding contract to use the platform.',
        'You are responsible for safeguarding your authentication credentials and for all activity that occurs under your account. Notify us promptly of any unauthorized use.',
      ],
    },
    {
      id: 'service',
      heading: '3. Use of the Service',
      body: [
        'We grant you a limited, non-exclusive, non-transferable, revocable right to access and use the platform in accordance with these Terms.',
        'You may use the service only for lawful purposes and in compliance with these Terms, including the Acceptable Use Policy in Section 9.',
      ],
    },
    {
      id: 'billing',
      heading: '4. Subscriptions, Billing, and Payment',
      body: [
        'Paid plans are billed in advance on a recurring basis through our payment processor. By subscribing you authorize recurring charges until you cancel.',
        'Fees are non-refundable except where required by law or expressly stated. You are responsible for applicable taxes. We may change pricing prospectively with notice.',
      ],
    },
    {
      id: 'intellectual-property',
      heading: '5. Intellectual Property',
      body: [
        'The platform, including its software, content, and trademarks, is owned by us or our licensors and is protected by intellectual-property laws. Except for the rights expressly granted here, we reserve all rights.',
      ],
    },
    {
      id: 'user-content',
      heading: '6. User Content',
      body: [
        'You retain ownership of the content you submit. You grant us a limited license to host, process, and display that content solely to operate and improve the service for you.',
        'You are responsible for your content and represent that you have the rights necessary to submit it and that it does not violate these Terms or applicable law.',
      ],
    },
    {
      id: 'disclaimers',
      heading: '7. Disclaimers',
      body: [
        'The service is provided "as is" and "as available" without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement, to the maximum extent permitted by law.',
        'The platform provides AI-assisted practice and is not a substitute for professional, legal, medical, financial, or other expert advice.',
      ],
    },
    {
      id: 'limitation-of-liability',
      heading: '8. Limitation of Liability',
      body: [
        'To the maximum extent permitted by law, we will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of data, profits, or revenue, arising out of or related to your use of the platform.',
        'Our total aggregate liability for any claim relating to the service will not exceed the amounts you paid us for the service in the twelve (12) months preceding the event giving rise to the claim.',
      ],
    },
    {
      id: 'acceptable-use-policy',
      heading: '9. Acceptable Use Policy (AUP)',
      body: [
        'You agree not to misuse the platform. Prohibited activities include, without limitation, the following:',
        'Unlawful, infringing, fraudulent, or deceptive activity, or use that violates the rights of others.',
        'Attempting to gain unauthorized access to the platform, other accounts or organizations, or any connected systems or data, including probing, scanning, or circumventing security or authentication measures.',
        'Disrupting or degrading the platform, including denial-of-service attacks, distributing malware, scraping at scale, or imposing an unreasonable load on our infrastructure.',
        'Reverse engineering, decompiling, or attempting to extract source code, models, or trade secrets, except to the extent this restriction is prohibited by law.',
        'Uploading or generating content that is illegal, harassing, hateful, sexually exploitative of minors, or that promotes violence or self-harm; or using the service to harass, abuse, or harm others.',
        'Using the service to develop a competing product, or reselling or sublicensing access without our written permission.',
        'We may investigate suspected violations and may remove content, suspend, or terminate access for conduct that violates this Acceptable Use Policy, with or without notice depending on severity.',
      ],
    },
    {
      id: 'termination',
      heading: '10. Termination',
      body: [
        'You may stop using the platform at any time. We may suspend or terminate your access for violations of these Terms, to comply with law, or to protect the platform and its users.',
        'Provisions that by their nature should survive termination — including intellectual property, disclaimers, limitation of liability, and governing law — will survive.',
      ],
    },
    {
      id: 'changes',
      heading: '11. Changes to These Terms',
      body: [
        'We may update these Terms from time to time. When changes are material we will update the "Last updated" date and provide notice where appropriate. Your continued use of the platform after an update constitutes acceptance of the revised Terms.',
      ],
    },
    {
      id: 'governing-law',
      heading: '12. Governing Law and Disputes',
      body: [
        'These Terms are governed by the laws applicable to our operating entity, without regard to conflict-of-laws principles. Disputes will be resolved in the courts of competent jurisdiction for that entity, except where applicable consumer-protection law grants you the right to bring a claim in your local jurisdiction.',
      ],
    },
    {
      id: 'contact',
      heading: '13. Contact',
      body: [`Questions about these Terms can be sent to ${LEGAL_CONTACT}.`],
    },
  ],
};
