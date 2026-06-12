/**
 * /settings/[tab] (SAU-253) — the Settings hub. Renders the shared shell (header
 * + left sub-nav) and the active tab's panel. Server component: each tab fetches
 * its own data for the authenticated actor; the interactive tabs delegate to
 * client islands. Unknown tabs 404.
 *
 * Tabs reuse existing features where they exist:
 *   • Account          → app_user + entitlement (read-only)
 *   • Language         → user_setting (services/settings)
 *   • Memory           → coach_memory (ADR-004), surfaced read-only
 *   • Knowledge Bases  → services/knowledge-base (SAU-243)
 *   • My Voice         → user_setting (services/settings)
 *   • Integrations     → user_setting (services/settings)
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getStore } from '@/db';
import { requirePageActor } from '@/services/current-user';
import SettingsShell, { isSettingsTab } from '@/components/SettingsShell';
import { Avatar } from '@/components/Avatar';
import {
  SUPPORTED_LANGUAGES,
  getPreferredLanguage,
  getVoiceProfile,
  listIntegrations,
  getAccountInfo,
} from '@/services/settings';
import { listOwnedKnowledgeBases } from '@/services/knowledge-base';
import { getMeterState } from '@/services/meter';
import LanguageSettings from '../LanguageSettings';
import VoiceSettings from '../VoiceSettings';
import IntegrationsSettings from '../IntegrationsSettings';
import KnowledgeBaseSettings from '../KnowledgeBaseSettings';

export const dynamic = 'force-dynamic';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export default async function SettingsTabPage({ params }: { params: { tab: string } }) {
  const { tab } = params;
  if (!isSettingsTab(tab)) notFound();

  const store = getStore();
  const actor = await requirePageActor();

  return (
    <SettingsShell active={tab}>
      {tab === 'account' && (await AccountPanel(store, actor.userId))}
      {tab === 'language' && (await LanguagePanel(store, actor.userId))}
      {tab === 'memory' && (await MemoryPanel(store, actor.userId))}
      {tab === 'knowledge-bases' && (await KnowledgeBasesPanel(store, actor.userId, actor.isAdmin))}
      {tab === 'my-voice' && (await VoicePanel(store, actor.userId))}
      {tab === 'integrations' && (await IntegrationsPanel(store, actor.userId))}
    </SettingsShell>
  );
}

// ── Account ────────────────────────────────────────────────────────────────--
async function AccountPanel(store: ReturnType<typeof getStore>, userId: string) {
  const [info, meter] = await Promise.all([
    getAccountInfo(store, userId),
    getMeterState(store, userId),
  ]);
  if (!info) return <p className="billing-muted">Account information is unavailable.</p>;
  const tierLabel = info.planTier.charAt(0).toUpperCase() + info.planTier.slice(1);
  const fmtMin = (m: number) => (Number.isInteger(m) ? `${m}` : m.toFixed(1));
  const usedPct = meter.capMinutes > 0 ? Math.min(100, Math.round((meter.usedMinutes / meter.capMinutes) * 100)) : 0;
  return (
    <div className="settings-section">
      <h2>Account Info</h2>
      <p className="billing-muted">Your profile details and account information.</p>

      <div className="settings-identity">
        <Avatar name={info.displayName} category="account" slug={info.email} size={56} />
        <div>
          <div className="settings-identity-name">{info.displayName}</div>
          <div className="billing-muted">{info.email}</div>
        </div>
      </div>

      <dl className="settings-facts">
        <div><dt>Email</dt><dd>{info.email}</dd></div>
        <div><dt>Login method</dt><dd>{info.loginMethod}</dd></div>
        <div><dt>Plan</dt><dd>{tierLabel}</dd></div>
        <div><dt>Member since</dt><dd>{fmtDate(info.memberSince)}</dd></div>
        <div>
          <dt>Organizations</dt>
          <dd>{info.organizations.length ? info.organizations.join(', ') : 'No organizations'}</dd>
        </div>
      </dl>

      {/* Voice minutes (SAU-257) — the remaining-minutes read. Free tier gets a
          monthly voice budget on the cheap engine; when it's spent, practice
          continues in unlimited text Chat (no hard paywall). */}
      <h3 className="settings-subhead">Voice minutes</h3>
      <p className="billing-muted">
        {meter.overCap
          ? <>You&apos;ve used your <strong>{fmtMin(meter.capMinutes)}</strong> voice minutes this month. Keep practicing in <strong>text Chat</strong> (unlimited) or <a href="/billing">upgrade</a> for more voice time.</>
          : <><strong>{fmtMin(meter.remainingMinutes)}</strong> of {fmtMin(meter.capMinutes)} voice minutes left this month.</>}
      </p>
      <div className="settings-meter-bar" aria-hidden="true">
        <span className="settings-meter-fill" style={{ width: `${usedPct}%` }} />
      </div>
      <dl className="settings-facts">
        <div><dt>Used this month</dt><dd>{fmtMin(meter.usedMinutes)} min</dd></div>
        <div><dt>Monthly allowance</dt><dd>{fmtMin(meter.capMinutes)} min</dd></div>
        <div><dt>Per-session limit</dt><dd>{meter.sessionMaxMinutes == null ? 'None' : `${fmtMin(meter.sessionMaxMinutes)} min`}</dd></div>
        <div><dt>Resets</dt><dd>{fmtDate(meter.resetsAt)}</dd></div>
      </dl>
    </div>
  );
}

// ── Language ───────────────────────────────────────────────────────────────--
async function LanguagePanel(store: ReturnType<typeof getStore>, userId: string) {
  const current = await getPreferredLanguage(store, userId);
  return <LanguageSettings languages={SUPPORTED_LANGUAGES} current={current} />;
}

// ── Memory ─────────────────────────────────────────────────────────────────--
async function MemoryPanel(store: ReturnType<typeof getStore>, userId: string) {
  // Memory is derived per coach (ADR-004). Gather what's been extracted across
  // the user's coaches; read-only here (manage/erase lives on each coach page).
  const coaches = await store.listCoaches();
  const groups = await Promise.all(
    coaches.map(async (c) => ({
      coach: c,
      memories: await store.listCoachMemory(c.id, userId),
    })),
  );
  const nonEmpty = groups.filter((g) => g.memories.length > 0);
  const total = nonEmpty.reduce((n, g) => n + g.memories.length, 0);

  return (
    <div className="settings-section">
      <h2>Memory</h2>
      <p className="billing-muted">
        Memory is built automatically from your conversations. The AI extracts key details so sessions feel more
        personalized. You control it per coach — review or erase memory from each coach&apos;s page.
      </p>

      {total === 0 ? (
        <p className="billing-muted">
          No memories yet. As you practice with coaches, key details will appear here.
        </p>
      ) : (
        <div className="settings-memory-groups">
          {nonEmpty.map((g) => (
            <div key={g.coach.id} className="settings-memory-group">
              <div className="settings-memory-coach">
                <Link href={`/coaches/${g.coach.slug}`}>{g.coach.name}</Link>
                <span className="billing-muted">{g.memories.length} item{g.memories.length === 1 ? '' : 's'}</span>
              </div>
              <ul className="settings-memory-list">
                {g.memories.map((m) => (
                  <li key={m.id}>
                    <span className="settings-badge">{m.kind}</span>
                    {m.content}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Knowledge Bases ──────────────────────────────────────────────────────────
async function KnowledgeBasesPanel(store: ReturnType<typeof getStore>, userId: string, isAdmin: boolean) {
  const kbs = await listOwnedKnowledgeBases(store, { userId, isAdmin });
  const initial = kbs.map((k) => ({
    id: k.id,
    title: k.title,
    description: k.description,
    docCount: k.docCount,
    createdAt: k.createdAt,
  }));
  return <KnowledgeBaseSettings initial={initial} />;
}

// ── My Voice ───────────────────────────────────────────────────────────────--
async function VoicePanel(store: ReturnType<typeof getStore>, userId: string) {
  const profile = await getVoiceProfile(store, userId);
  return <VoiceSettings initial={profile} />;
}

// ── Integrations ─────────────────────────────────────────────────────────────
async function IntegrationsPanel(store: ReturnType<typeof getStore>, userId: string) {
  const integrations = await listIntegrations(store, userId);
  return <IntegrationsSettings integrations={integrations} />;
}
