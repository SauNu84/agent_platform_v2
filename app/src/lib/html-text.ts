/**
 * Tiny dependency-free helpers for the "Additional Context for AI" feature
 * (SAU-238 ask #7). We fetch a URL server-side, strip it to readable text, and
 * fold that text into the scenario's system prompt as reference context.
 *
 * Kept pure + minimal (no scraping lib) so it is unit-testable and adds no deps.
 */

const MAX_CONTEXT_CHARS = 6000;

/** Strip HTML to a bounded plain-text approximation suitable for prompt context. */
export function htmlToText(html: string, maxChars = MAX_CONTEXT_CHARS): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')        // drop tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n') // collapse blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

/** Best-effort <title> for labeling the source. */
export function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/**
 * Allow only public http(s) URLs. Blocks loopback/private/link-local hosts to
 * reduce SSRF when fetching author-supplied URLs server-side.
 */
export function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
  // IPv6 loopback / link-local.
  if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return false;
  // IPv4 private / loopback / link-local ranges.
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
  return true;
}

export { MAX_CONTEXT_CHARS };
