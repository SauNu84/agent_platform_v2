/**
 * POST /api/authoring/extract-pdf — "Additional Context for AI" PDF ingestion
 * (SAU-238 ask #8).
 *
 * Accepts a PDF upload (multipart form-data, field `file`), extracts its text
 * server-side with a real parser (unpdf/pdf.js), and returns bounded plain text.
 * The author then saves it on the scenario (metadata._aiContext) and it is folded
 * into the model's system prompt as reference context. Gated by `author_content`.
 *
 * Form: file=<pdf>  →  { text, chars, source }
 */
import { NextRequest, NextResponse } from 'next/server';
import { actorWithCapability } from '@/auth/api-guard';
import { extractPdfText } from '@/lib/pdf-text';

export const dynamic = 'force-dynamic';

const MAX_PDF_BYTES = 10_000_000; // 10MB upload cap

export async function POST(req: NextRequest) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart form-data with a `file`' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: '`file` (a PDF) is required' }, { status: 400 });
  }
  const blob = file as File;
  if (blob.type && !/pdf/i.test(blob.type)) {
    return NextResponse.json({ error: `Expected a PDF, got ${blob.type}.` }, { status: 415 });
  }
  if (blob.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: `PDF too large (max ${MAX_PDF_BYTES / 1_000_000}MB).` }, { status: 413 });
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = await extractPdfText(bytes);
    if (!text) return NextResponse.json({ error: 'No extractable text found in that PDF (it may be scanned images).' }, { status: 422 });
    return NextResponse.json({ text, chars: text.length, source: blob.name || 'uploaded.pdf' });
  } catch (e) {
    return NextResponse.json({ error: `Could not read PDF: ${(e as Error).message}` }, { status: 502 });
  }
}
