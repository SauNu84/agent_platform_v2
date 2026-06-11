/**
 * Knowledge Base use-case layer (SAU-243, Phase 1). API routes stay thin; this
 * is what tests drive. Ownership is enforced here (KB read-RLS is intentionally
 * open for the injection path — see migration 0008), so management mutations
 * must check the actor explicitly.
 */
import type {
  KnowledgeBaseRecord, KnowledgeBaseDocRecord, OwnerOpts, Store,
} from '@/db/store';
import {
  assembleKnowledgeBaseContext, KB_CONTEXT_CHAR_BUDGET, type AssembledKnowledge,
} from '@/domain/scenario';
import { detectKbContentType, extractDocText, KB_DOC_MAX_BYTES } from '@/lib/extract-doc';

/** A 4xx-shaped error the API routes map to a status code. */
export class KnowledgeBaseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'KnowledgeBaseError';
  }
}

export interface KbActor {
  userId: string | null;
  isAdmin: boolean;
}

function assertOwner(kb: KnowledgeBaseRecord, actor: KbActor): void {
  if (actor.isAdmin) return;
  if (kb.ownerUserId === null) return; // shared/seeded
  if (kb.ownerUserId !== actor.userId) {
    throw new KnowledgeBaseError('You do not own this knowledge base.', 403);
  }
}

export async function createKnowledgeBase(
  store: Store,
  input: { title: string; description?: string | null },
  owner: OwnerOpts,
): Promise<KnowledgeBaseRecord> {
  const title = input.title?.trim();
  if (!title) throw new KnowledgeBaseError('Title is required.', 422);
  return store.createKnowledgeBase({ title, description: input.description?.trim() || null }, owner);
}

/** KBs the actor may manage (own + shared); admins see all. */
export async function listOwnedKnowledgeBases(store: Store, actor: KbActor): Promise<KnowledgeBaseRecord[]> {
  const all = await store.listKnowledgeBases();
  if (actor.isAdmin) return all;
  return all.filter((kb) => kb.ownerUserId === actor.userId || kb.ownerUserId === null);
}

export async function getOwnedKnowledgeBase(store: Store, id: string, actor: KbActor): Promise<KnowledgeBaseRecord> {
  const kb = await store.getKnowledgeBase(id);
  if (!kb) throw new KnowledgeBaseError('Knowledge base not found.', 404);
  assertOwner(kb, actor);
  return kb;
}

export async function deleteKnowledgeBase(store: Store, id: string, actor: KbActor): Promise<void> {
  await getOwnedKnowledgeBase(store, id, actor);
  await store.deleteKnowledgeBase(id);
}

/** Ingest one uploaded file into a KB: detect format → extract text → persist. */
export async function addDocumentFromUpload(
  store: Store,
  kbId: string,
  file: { name: string; type?: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  actor: KbActor,
): Promise<KnowledgeBaseDocRecord> {
  await getOwnedKnowledgeBase(store, kbId, actor);
  const type = detectKbContentType(file.name, file.type);
  if (!type) throw new KnowledgeBaseError('Unsupported file type. Use .pdf, .docx, or .txt.', 415);
  if (file.size > KB_DOC_MAX_BYTES) {
    throw new KnowledgeBaseError(`File too large (max ${KB_DOC_MAX_BYTES / (1024 * 1024)}MB).`, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = await extractDocText(bytes, type);
  if (!text) throw new KnowledgeBaseError('No extractable text found in that file.', 422);
  return store.addKnowledgeBaseDocument({
    kbId, filename: file.name || `document.${type}`, contentType: type, extractedText: text, byteSize: file.size,
  });
}

export async function linkToScenario(store: Store, scenarioId: string, kbId: string): Promise<void> {
  await store.linkScenarioKnowledgeBase(scenarioId, kbId);
}

export async function unlinkFromScenario(store: Store, scenarioId: string, kbId: string): Promise<boolean> {
  return store.unlinkScenarioKnowledgeBase(scenarioId, kbId);
}

export interface ResolvedKnowledge extends AssembledKnowledge {
  /** number of linked documents that contributed text. */
  docs: number;
}

/**
 * Resolve + assemble the linked-KB block for a scenario at session start.
 * Logs a notice when the global budget truncates (AC #4 — no silent overflow).
 * Returns the bounded text to pass into `modelInstructions`/`toCompiledScenario`.
 */
export async function resolveKnowledgeContext(store: Store, scenarioId: string): Promise<ResolvedKnowledge> {
  const docs = await store.listKnowledgeForScenario(scenarioId);
  const asm = assembleKnowledgeBaseContext(docs);
  if (asm.truncated) {
    console.warn(
      `[kb] scenario=${scenarioId}: linked knowledge (${docs.length} docs) exceeded KB_CONTEXT_CHAR_BUDGET ` +
        `(${KB_CONTEXT_CHAR_BUDGET} chars) — truncated with a visible marker (no silent overflow).`,
    );
  }
  return { ...asm, docs: docs.length };
}
