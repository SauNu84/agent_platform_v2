/**
 * Developer Tools (SAU-252) — the developer surface under Billing.
 *
 * Server component: reads the user's API keys + webhook endpoints, then renders
 * three sections — API Keys, Webhooks, and a static API Reference. The
 * create/revoke/delete interactions are a client island (DeveloperToolsClient)
 * so the rest renders server-side. No new metering or conversation engine.
 */
import { getStore } from '@/db';
import { requirePageActor } from '@/services/current-user';
import { listApiKeys, listWebhooks, WEBHOOK_EVENTS, API_REFERENCE } from '@/services/developer-tools';
import DeveloperToolsClient from './DeveloperToolsClient';

export const dynamic = 'force-dynamic';

export default async function DeveloperToolsPage() {
  const store = getStore();
  const actor = await requirePageActor();

  const [keys, webhooks] = await Promise.all([
    listApiKeys(store, actor.userId),
    listWebhooks(store, actor.userId),
  ]);

  // Strip the hash before sending to the client — it never needs the secret material.
  const keyViews = keys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  }));

  return (
    <div className="devtools">
      <h1>Developer Tools</h1>
      <p className="subtitle">
        Build on the Agent Platform API — mint keys, subscribe to events, and explore the reference.
      </p>

      <DeveloperToolsClient
        initialKeys={keyViews}
        initialWebhooks={webhooks}
        events={WEBHOOK_EVENTS.map((e) => ({ id: e.id, label: e.label, description: e.description }))}
      />

      {/* ── API Reference ─────────────────────────────────────────────────── */}
      <section className="billing-section devtools-reference">
        <h2>API Reference</h2>
        <p className="billing-muted">
          The public endpoints you can call with a key above. Authenticate every request with
          <code> Authorization: Bearer &lt;your key&gt;</code>.
        </p>
        {API_REFERENCE.map((group) => (
          <div className="devtools-ref-group" key={group.id}>
            <h3>{group.title}</h3>
            <p className="billing-muted">{group.description}</p>
            <ul className="devtools-ref-list">
              {group.endpoints.map((ep) => (
                <li key={`${ep.method} ${ep.path}`} className="devtools-ref-endpoint">
                  <div className="devtools-ref-sig">
                    <span className={`devtools-method ${ep.method.toLowerCase()}`}>{ep.method}</span>
                    <code className="devtools-path">{ep.path}</code>
                  </div>
                  <p className="devtools-ref-summary">{ep.summary}</p>
                  <pre className="devtools-ref-example"><code>{ep.example}</code></pre>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
