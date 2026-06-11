/**
 * PDF text extraction for "Additional Context for AI" (SAU-238 ask #8).
 *
 * Real extraction — no faking: `unpdf` ships a serverless build of Mozilla's
 * pdf.js, so this runs in a Next.js Node route with no native deps or workers.
 * The extracted text is folded into the scenario's system prompt as reference
 * context (see domain `modelInstructions`), which is what "makes the agent good
 * after config".
 */
import { MAX_CONTEXT_CHARS } from './html-text';

/** Extract and bound the text of a PDF given its bytes. Throws on an unreadable PDF. */
export async function extractPdfText(bytes: Uint8Array, maxChars = MAX_CONTEXT_CHARS): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join('\n\n') : text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return merged.length > maxChars ? `${merged.slice(0, maxChars).trimEnd()}…` : merged;
}
