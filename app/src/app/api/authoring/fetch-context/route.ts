/**
 * POST /api/authoring/fetch-context — "Additional Context for AI" URL ingestion
 * (SAU-238 ask #7).
 *
 * Fetches an author-supplied URL server-side, strips it to bounded plain text,
 * and returns it for the author to review. The text is then saved on the scenario
 * (metadata._aiContext) and folded into the model's system prompt as reference
 * context (see domain `modelInstructions`). Gated by the `author_content`
 * capability; only public http(s) URLs are allowed (SSRF guard).
 *
 * Body: { url: string }  →  { text, chars, title, source }
 */
import { NextRequest, NextResponse } from 'next/server';
import { actorWithCapability } from '@/auth/api-guard';
import { htmlToText, htmlTitle, isFetchableUrl } from '@/lib/html-text';

export const dynamic = 'force-dynamic';

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 2_000_000; // 2MB cap on the fetched body

export async function POST(req: NextRequest) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return NextResponse.json({ error: '`url` is required' }, { status: 400 });
  if (!isFetchableUrl(url)) {
    return NextResponse.json({ error: 'Only public http(s) URLs are allowed.' }, { status: 400 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'AgentPlatform-ContextFetcher/1.0', accept: 'text/html,text/plain,*/*' },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Could not fetch URL (HTTP ${res.status}).` }, { status: 502 });
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype) && ctype) {
      return NextResponse.json({ error: `Unsupported content type for context: ${ctype.split(';')[0]}. Use a web page (PDF/YouTube coming soon).` }, { status: 415 });
    }
    const raw = (await res.text()).slice(0, MAX_BYTES);
    const text = htmlToText(raw);
    if (!text) return NextResponse.json({ error: 'No readable text found at that URL.' }, { status: 422 });
    return NextResponse.json({ text, chars: text.length, title: htmlTitle(raw), source: url });
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Fetch timed out.' : (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
