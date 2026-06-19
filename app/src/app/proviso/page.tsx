/**
 * Proviso — commercial marketing landing page (SAU-349, WS4 of SAU-345).
 *
 * Positions the product on the *compliance-grade Agent Framework* wedge
 * (WS2 positioning brief, SAU-347): we win on provable compliance + correctness,
 * not AI-receptionist feature parity (CMO GTM co-sign, SAU-343). Surfaces the
 * three flagship archetype templates (Clinic Secretary / HRM Interview Panel /
 * Meeting Notetaker) as use-case sections, and a single sales-led design-partner
 * CTA aligned with the board-approved Stage-1 GTM motion (SAU-290).
 *
 * Brand "Proviso" is the founder's WS1 pick (SAU-346): compliance-by-construction
 * + "pro-voice". Master brand; verticals read "Proviso for Clinics / Collections".
 *
 * Instrumentation: every CTA + the page view fire through the WS5 tracking seam
 * (`@/lib/track` → window.dataLayer). WS5 (SAU-350) wires the provider without
 * re-touching this page. Server component; only the tracked bits are client.
 */
import type { Metadata } from 'next';
import ProvisoTracking from '@/components/proviso/ProvisoTracking';
import TrackedLink from '@/components/proviso/TrackedLink';

export const metadata: Metadata = {
  title: 'Proviso — Provably compliant AI agents for regulated operations',
  description:
    'Proviso is a compliance-grade Agent Framework: action-taking AI agents across voice, text, and SMS whose guardrails are enforced in code and audited — not promised in a prompt.',
};

// The design-partner inbox is sales-led and gated (Stage-1 GTM, SAU-290). The
// proviso.ai domain is the founder's brand (SAU-346); securing it is SAU-357.
const DESIGN_PARTNER_MAILTO =
  'mailto:design-partners@proviso.ai?subject=Proviso%20design-partner%20interest';

type Pillar = { title: string; body: string };

// The wedge (positioning brief §3). What the long tail of voice-agent startups
// does not have — stated as buyer value, grounded in shipped code.
const WEDGE: Pillar[] = [
  {
    title: 'Compliance is the product',
    body: 'PHI-at-rest encryption, append-only HMAC audit ledgers, row-level multi-tenancy, a HIPAA go-live gate, and a server-side collections compliance engine. Not a checkbox bolted onto a chatbot — the reason the agent is safe to deploy.',
  },
  {
    title: 'Guardrails enforced in code',
    body: 'Rules live in the engine and the tools, not the prompt. A non-compliant action is impossible by construction — fail-closed, un-overridable, and impossible to jailbreak away with a clever message.',
  },
  {
    title: 'Proof harnesses, not demos',
    body: 'Every deployment ships with a runnable case study — a clinic 20-call run, a collections 10/10-guardrail run — that a design partner can re-run against their own configuration. Evidence you can execute, not a scripted sizzle reel.',
  },
];

type Surface = { label: string; items: string };

// The 2×3 surface (positioning brief §2): one engine, many channels and topologies.
const SURFACE: Surface[] = [
  { label: 'Modalities', items: 'Web text · Phone voice · SMS — the same agent, every channel.' },
  {
    label: 'Topologies',
    items: 'A single agent that owns a job end-to-end, or a Super Agent — a supervisor coordinating specialist sub-agents.',
  },
  {
    label: 'Vendor-neutral by design',
    items: 'Calendar, telephony, notification, and chat seams proven 7+ times. A new vendor or channel is an interface to implement, not a rebuild.',
  },
];

type Archetype = {
  name: string;
  vertical: string;
  topology: string;
  modalities: string;
  blurb: string;
  status: string;
  statusClass: string;
  ctaLabel: string;
  href: string;
  event: 'archetype_cta_click';
};

// The three flagship archetype templates (positioning brief §5). Clinic leads
// the Stage-1 pilot; HRM + Meeting demonstrate the framework generalizes.
const ARCHETYPES: Archetype[] = [
  {
    name: 'Clinic Secretary',
    vertical: 'Proviso for Clinics',
    topology: 'Single-agent',
    modalities: 'Voice · Web text · SMS',
    blurb:
      'Answers the front-desk phone, books and reschedules against the real calendar, captures intake, and escalates to a human when it should. Already live-proven booking real appointments over real calls — behind a HIPAA go-live gate.',
    status: 'Live-proven · pilot lead',
    statusClass: 'public',
    ctaLabel: 'See the clinic agent',
    href: '/use-cases/clinic-agent',
    event: 'archetype_cta_click',
  },
  {
    name: 'HRM Interview Panel',
    vertical: 'Proviso for Hiring',
    topology: 'Super Agent',
    modalities: 'Web text',
    blurb:
      'A supervisor runs a coordinated panel of specialist interviewer sub-agents in one session, then synthesizes a structured, evidence-backed recommendation — every claim traceable to what the candidate actually said.',
    status: 'Built · v1',
    statusClass: 'hiring',
    ctaLabel: 'Become a design partner',
    href: DESIGN_PARTNER_MAILTO,
    event: 'archetype_cta_click',
  },
  {
    name: 'Meeting Notetaker',
    vertical: 'Proviso for Teams',
    topology: 'Meeting agent',
    modalities: 'Async ingest → report',
    blurb:
      'Ingests a meeting transcript and returns a structured recap, decisions, and action items routed to your tools — no scripted persona, no live bot in the call. Built on the same audited responder engine.',
    status: 'On the roadmap',
    statusClass: 'productivity',
    ctaLabel: 'Become a design partner',
    href: DESIGN_PARTNER_MAILTO,
    event: 'archetype_cta_click',
  },
];

export default function ProvisoLanding() {
  return (
    <div className="proviso-landing">
      <ProvisoTracking />

      <header className="hero">
        <span className="badge">Compliance-grade Agent Framework</span>
        <h1>AI agents that are provably compliant — not just convincing.</h1>
        <p className="subtitle">
          Proviso ships action-taking AI agents across voice, text, and SMS for regulated, high-stakes
          operations — healthcare front-desk, collections — that cannot risk a hallucinating or
          non-compliant bot. Our guardrails are enforced in code and audited, not promised in a prompt.
        </p>
        <div className="hero-cta">
          <TrackedLink
            href={DESIGN_PARTNER_MAILTO}
            event="cta_design_partner_click"
            props={{ location: 'hero' }}
            className="btn join"
          >
            Become a design partner
          </TrackedLink>
          <TrackedLink
            href="#how-it-works"
            event="cta_how_it_works_click"
            props={{ location: 'hero' }}
            className="btn-sm"
          >
            How it works
          </TrackedLink>
        </div>
      </header>

      <section className="pv-section" id="why-proviso">
        <h2>Why Proviso</h2>
        <p className="pv-lead">
          The AI voice-agent category is crowded with receptionist parity. We do not win there. We win
          where a wrong or non-compliant action is a legal liability — and prove it in code.
        </p>
        <div className="grid">
          {WEDGE.map((p) => (
            <div className="card" key={p.title}>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="pv-section" id="how-it-works">
        <h2>One engine, every channel</h2>
        <p className="pv-lead">
          Two axes define the framework — modality and topology. Every Proviso agent is a point in that
          grid, instantiated from a productized template you tune for your vertical.
        </p>
        <div className="grid">
          {SURFACE.map((s) => (
            <div className="card" key={s.label}>
              <h3>{s.label}</h3>
              <p>{s.items}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="pv-section" id="archetypes">
        <h2>Three flagship templates</h2>
        <p className="pv-lead">
          Start from a productized archetype, not a blank canvas. Each is a real, action-taking agent —
          packaged for a vertical and ready to instantiate against your configuration.
        </p>
        <div className="grid">
          {ARCHETYPES.map((a) => (
            <div className="card pv-archetype" key={a.name}>
              <div className="badges">
                <span className={`badge ${a.statusClass}`}>{a.status}</span>
              </div>
              <h3>{a.name}</h3>
              <div className="pv-meta">
                <span>{a.vertical}</span>
                <span>· {a.topology}</span>
                <span>· {a.modalities}</span>
              </div>
              <p>{a.blurb}</p>
              <TrackedLink
                href={a.href}
                event={a.event}
                props={{ archetype: a.name }}
                className="btn-sm"
              >
                {a.ctaLabel} →
              </TrackedLink>
            </div>
          ))}
        </div>
      </section>

      <section className="pv-cta" id="design-partner">
        <h2>Run your compliance-critical workflow on Proviso.</h2>
        <p>
          We are onboarding a small cohort of design partners in healthcare and collections. This is a
          guided, sales-led engagement — we configure the agent to your workflow, run the proof harness
          against your own data, and stand it up behind the appropriate go-live gate. No self-serve, no
          live patient or debtor calls before sign-off.
        </p>
        <TrackedLink
          href={DESIGN_PARTNER_MAILTO}
          event="cta_design_partner_click"
          props={{ location: 'footer' }}
          className="btn join"
        >
          Become a design partner
        </TrackedLink>
        <p className="notice">
          Proviso is in a gated design-partner stage. Agents run against synthetic data until each
          deployment&apos;s compliance gate is fully green.
        </p>
      </section>
    </div>
  );
}
