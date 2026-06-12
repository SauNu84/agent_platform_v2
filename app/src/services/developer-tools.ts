/**
 * Developer Tools service (SAU-252) — programmatic access for the platform API.
 *
 * Three capabilities, surfaced on the /developer-tools page under Billing:
 *   1. API keys  — mint/list/revoke keys used as `Authorization: Bearer <key>`.
 *   2. Webhooks  — register endpoints that receive event callbacks, each with a
 *                  signing secret the receiver uses to verify authenticity.
 *   3. API Reference — a static, first-party catalog of the public endpoints a
 *                  developer can call (original content; grounded in this
 *                  platform's real routes — no copied competitor docs, per the
 *                  SAU-245/234 IP lesson).
 *
 * Security: the full API key is generated here, shown to the caller EXACTLY ONCE,
 * and only its SHA-256 hash + a non-secret display prefix are persisted. The
 * service never reads a stored key back in plaintext — it can't.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { Store, ApiKeyRecord, WebhookRecord } from '@/db/store';

// ── Key + secret minting ─────────────────────────────────────────────────────

const KEY_PREFIX = 'ak_live_';
const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** URL-safe base62-ish token from CSPRNG bytes. */
function token(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hashKey(fullKey: string): string {
  return createHash('sha256').update(fullKey).digest('hex');
}

/** The shape returned once at creation — includes the plaintext key. */
export interface NewApiKeyResult {
  record: ApiKeyRecord;
  /** Full secret key. Returned ONCE; never persisted or retrievable again. */
  plaintext: string;
}

export class InvalidWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}

/** Mint a new API key for a user. Persists hash+prefix; returns the plaintext once. */
export async function createApiKey(
  store: Store,
  userId: string,
  rawName: string,
): Promise<NewApiKeyResult> {
  const name = rawName.trim() || 'Untitled key';
  const plaintext = `${KEY_PREFIX}${token(24)}`;
  // Display stub: prefix + first 6 chars of the random part, then an ellipsis.
  const keyPrefix = `${plaintext.slice(0, KEY_PREFIX.length + 6)}…`;
  const record: ApiKeyRecord = {
    id: randomUUID(),
    userId,
    name,
    keyPrefix,
    keyHash: hashKey(plaintext),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
  await store.createApiKey(record);
  return { record, plaintext };
}

export function listApiKeys(store: Store, userId: string): Promise<ApiKeyRecord[]> {
  return store.listApiKeys(userId);
}

export function revokeApiKey(store: Store, userId: string, id: string): Promise<ApiKeyRecord | null> {
  return store.revokeApiKey(userId, id);
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/** The event types a webhook endpoint can subscribe to (real platform events). */
export const WEBHOOK_EVENTS = [
  { id: 'session.started', label: 'Session started', description: 'A practice session began.' },
  { id: 'session.completed', label: 'Session completed', description: 'A session ended and its transcript is final.' },
  { id: 'analysis.ready', label: 'Analysis ready', description: 'Scoring/feedback for a session is available.' },
  { id: 'course.completed', label: 'Course completed', description: 'A user finished every scenario in a course.' },
] as const;

const VALID_EVENT_IDS = new Set(WEBHOOK_EVENTS.map((e) => e.id));

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Register a webhook endpoint. Validates the URL + event ids; mints a secret. */
export async function createWebhook(
  store: Store,
  userId: string,
  rawUrl: string,
  events: string[],
): Promise<WebhookRecord> {
  const url = rawUrl.trim();
  if (!isValidUrl(url)) throw new InvalidWebhookError('a valid http(s) URL is required');

  const cleaned = [...new Set(events)].filter((e) => VALID_EVENT_IDS.has(e as (typeof WEBHOOK_EVENTS)[number]['id']));
  if (cleaned.length === 0) throw new InvalidWebhookError('select at least one event to subscribe to');

  const record: WebhookRecord = {
    id: randomUUID(),
    userId,
    url,
    secret: `${WEBHOOK_SECRET_PREFIX}${token(24)}`,
    events: cleaned,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  await store.createWebhook(record);
  return record;
}

export function listWebhooks(store: Store, userId: string): Promise<WebhookRecord[]> {
  return store.listWebhooks(userId);
}

export function deleteWebhook(store: Store, userId: string, id: string): Promise<boolean> {
  return store.deleteWebhook(userId, id);
}

// ── API Reference (static, first-party) ──────────────────────────────────────

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  summary: string;
  /** A short, copy-pasteable cURL-style example. */
  example: string;
}

export interface ApiReferenceGroup {
  id: string;
  title: string;
  description: string;
  endpoints: ApiEndpoint[];
}

/**
 * The published API surface. Original content describing this platform's own
 * resources (scenarios, sessions, analysis, usage) as a developer would consume
 * them with a Bearer API key. Keep in sync with the real routes when they change.
 */
export const API_REFERENCE: ApiReferenceGroup[] = [
  {
    id: 'authentication',
    title: 'Authentication',
    description:
      'Every request is authenticated with an API key minted above, sent as a Bearer token. Keep keys secret — treat them like passwords and revoke any that leak.',
    endpoints: [
      {
        method: 'GET',
        path: '/v1/usage',
        summary: 'Return the current voice-minute balance and plan for the authenticated account.',
        example: `curl https://api.agentplatform.dev/v1/usage \\
  -H "Authorization: Bearer ak_live_…"`,
      },
    ],
  },
  {
    id: 'scenarios',
    title: 'Scenarios',
    description: 'Browse the practice scenarios available to your account.',
    endpoints: [
      {
        method: 'GET',
        path: '/v1/scenarios',
        summary: 'List published scenarios, newest first.',
        example: `curl https://api.agentplatform.dev/v1/scenarios \\
  -H "Authorization: Bearer ak_live_…"`,
      },
      {
        method: 'GET',
        path: '/v1/scenarios/{slug}',
        summary: 'Fetch a single scenario by its slug, including its rubric.',
        example: `curl https://api.agentplatform.dev/v1/scenarios/cold-open-pitch \\
  -H "Authorization: Bearer ak_live_…"`,
      },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions',
    description: 'Start a practice session and retrieve its analysis once complete.',
    endpoints: [
      {
        method: 'POST',
        path: '/v1/scenarios/{slug}/sessions',
        summary: 'Start a new practice session for a scenario. Returns a session id.',
        example: `curl -X POST https://api.agentplatform.dev/v1/scenarios/cold-open-pitch/sessions \\
  -H "Authorization: Bearer ak_live_…"`,
      },
      {
        method: 'POST',
        path: '/v1/sessions/{id}/analyze',
        summary: 'Score a completed session against its rubric and produce feedback.',
        example: `curl -X POST https://api.agentplatform.dev/v1/sessions/{id}/analyze \\
  -H "Authorization: Bearer ak_live_…"`,
      },
      {
        method: 'GET',
        path: '/v1/sessions/{id}/analysis',
        summary: 'Retrieve the analysis (scores + improvements) for a session.',
        example: `curl https://api.agentplatform.dev/v1/sessions/{id}/analysis \\
  -H "Authorization: Bearer ak_live_…"`,
      },
    ],
  },
];
