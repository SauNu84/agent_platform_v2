/**
 * Edge-safe auth constants. Kept dependency-free so Next.js middleware (edge
 * runtime) can import the cookie name without pulling in node:crypto / pg.
 */
export const SESSION_COOKIE = 'ap_session';
/** Session lifetime (30 days). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
