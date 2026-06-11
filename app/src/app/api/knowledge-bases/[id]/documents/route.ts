/**
 * POST /api/knowledge-bases/[id]/documents — upload a document into a KB (SAU-243).
 *
 * Multipart form-data, field `file` (.pdf/.docx/.txt, ≤25MB). The text is
 * extracted server-side (reusing the Additional-Context plumbing + mammoth for
 * .docx) and stored; the raw upload is discarded. Owner/admin only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorWithCapability } from '@/auth/api-guard';
import { addDocumentFromUpload, KnowledgeBaseError } from '@/services/knowledge-base';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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
    return NextResponse.json({ error: '`file` is required' }, { status: 400 });
  }
  try {
    const doc = await addDocumentFromUpload(getStore(), params.id, file as File, {
      userId: gate.actor.userId, isAdmin: gate.actor.isAdmin,
    });
    return NextResponse.json({
      document: { id: doc.id, filename: doc.filename, contentType: doc.contentType, chars: doc.chars, byteSize: doc.byteSize, createdAt: doc.createdAt },
    }, { status: 201 });
  } catch (e) {
    if (e instanceof KnowledgeBaseError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: `Could not read file: ${(e as Error).message}` }, { status: 502 });
  }
}
