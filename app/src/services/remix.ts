/**
 * Remix (SAU-226) — clone a source scenario's config into a fresh, editable draft
 * the current user owns. This is the pure mapping the Scenario Studio create form
 * pre-fills from when opened with `?remix={slug}`; saving it POSTs a brand-new
 * scenario via the same /api/scenarios path the Classic create form uses (SAU-214),
 * so the draft lands in the Library's "My Scenarios" tab (metadata._source = 'user')
 * and remains editable later.
 *
 * Kept as a pure function (no I/O) so the clone semantics are unit-testable
 * independent of the form and the network.
 */
import type { RubricItem, ScenarioRecord } from '@/domain/scenario';

/** The frontmatter-shaped draft the create form pre-fills + submits for a remix. */
export interface RemixDraft {
  name: string;
  slug: string;
  description: string | null;
  /** Canonical author field = the source's compiled aiInstructions. */
  persona: string;
  rubric: RubricItem[];
  /** Remixes start as a private draft the user owns; they can flip it later. */
  visibility: 'private';
  voice: { name: string; language: string };
  metadata: Record<string, unknown>;
}

/** Internal metadata keys we own — never carried verbatim from the source. */
const RESERVED_META_KEYS = ['_source', '_remixedFrom'];

/** Derive a fresh, kebab-valid slug for a remix of `sourceSlug`. */
export function remixSlug(sourceSlug: string): string {
  // sourceSlug is already kebab-case; appending a suffix keeps it valid.
  return `${sourceSlug}-remix`.slice(0, 60).replace(/-+$/g, '');
}

/**
 * Build the editable draft seeded from a source scenario's full config:
 * name → "… (remix)", persona/instructions, rubric, voice, and the source's
 * public-facing metadata (role/difficulty/etc.) — minus our reserved keys, which
 * we set ourselves: _source='user' (so it shows under "My Scenarios") and
 * _remixedFrom (provenance back to the original).
 */
export function buildRemixConfig(source: ScenarioRecord): RemixDraft {
  const carried: Record<string, unknown> = { ...source.metadata };
  for (const k of RESERVED_META_KEYS) delete carried[k];

  return {
    name: `${source.name} (remix)`,
    slug: remixSlug(source.slug),
    description: source.description,
    persona: source.aiInstructions,
    rubric: source.rubric.map((r) => ({ ...r })),
    visibility: 'private',
    voice: { name: source.voiceName, language: source.languageCode },
    metadata: { ...carried, _source: 'user', _remixedFrom: source.slug },
  };
}
