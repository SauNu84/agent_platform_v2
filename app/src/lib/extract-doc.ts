/**
 * Knowledge Base document text extraction (SAU-243, Phase 1).
 *
 * One entry point for the three Phase-1 formats, reusing the plumbing the
 * "Additional Context for AI" feature already shipped:
 *   - .pdf  → `extractPdfText` (unpdf / pdf.js, real extraction, no native deps)
 *   - .docx → `mammoth` (pure-JS OOXML reader; raw text only — formatting dropped)
 *   - .txt  → UTF-8 passthrough
 *
 * We store ONLY the extracted text (+ char/byte counts), never the raw upload —
 * the text is what gets folded into the system prompt (see domain
 * `assembleKnowledgeBaseContext`). Embeddings/RAG/OCR are Phase 2.
 */
import { extractPdfText } from './pdf-text';

/** Per-document upload cap (matches the reference UI). */
export const KB_DOC_MAX_BYTES = 25 * 1024 * 1024; // 25MB
/**
 * Per-document extracted-text cap. A single doc can't blow the whole prompt;
 * the GLOBAL budget across all linked KBs is enforced later by
 * `assembleKnowledgeBaseContext` (KB_CONTEXT_CHAR_BUDGET).
 */
export const KB_DOC_MAX_CHARS = 200_000;

export type KbContentType = 'pdf' | 'docx' | 'txt';

const EXT_TYPE: Record<string, KbContentType> = { pdf: 'pdf', docx: 'docx', txt: 'txt' };

/** Resolve the content type from filename extension (preferred) or MIME, or null. */
export function detectKbContentType(filename: string, mime?: string): KbContentType | null {
  const ext = (filename.toLowerCase().split('.').pop() ?? '').trim();
  if (ext in EXT_TYPE) return EXT_TYPE[ext];
  const m = mime ?? '';
  if (/pdf/i.test(m)) return 'pdf';
  if (/wordprocessingml|officedocument\.word/i.test(m)) return 'docx';
  if (/^text\/plain/i.test(m)) return 'txt';
  return null;
}

function clean(raw: string, maxChars: number): string {
  const merged = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return merged.length > maxChars ? `${merged.slice(0, maxChars).trimEnd()}…` : merged;
}

/** Extract and bound the text of a KB document given its bytes + detected type. */
export async function extractDocText(
  bytes: Uint8Array,
  type: KbContentType,
  maxChars = KB_DOC_MAX_CHARS,
): Promise<string> {
  if (type === 'pdf') return extractPdfText(bytes, maxChars); // already cleaned + bounded
  if (type === 'docx') {
    const mod: any = await import('mammoth');
    const mammoth = mod.default ?? mod;
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return clean(value ?? '', maxChars);
  }
  // txt passthrough — tolerate undecodable bytes rather than throw.
  return clean(new TextDecoder('utf-8', { fatal: false }).decode(bytes), maxChars);
}
