/**
 * Category palette — the single source for mapping a free-text category/role
 * facet (Sales, PM, SWE, …) to one of the P1 visual-system palette classes
 * (SAU-215: Sales=orange, Productivity=blue, Training=green, Hiring=purple).
 *
 * Extracted so the Library (filter badges) and the Home page (cards + avatars)
 * colour-code categories identically — known names map directly, any other facet
 * gets a stable palette colour by hash so every category badge reads as coded.
 */
export const CATEGORY_PALETTE = ['sales', 'productivity', 'training', 'hiring'] as const;
export type CategoryClass = (typeof CATEGORY_PALETTE)[number];

/** Stable hash of a string (deterministic across server renders). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function categoryClass(value: string): CategoryClass {
  const v = value.toLowerCase();
  if ((CATEGORY_PALETTE as readonly string[]).includes(v)) return v as CategoryClass;
  return CATEGORY_PALETTE[hash(v) % CATEGORY_PALETTE.length];
}

/**
 * Curated gradient stops (tailwind 400→600 of each palette hue) for the deterministic
 * avatar generator. Keyed by palette class so the avatar tint matches the category tag.
 */
export const CATEGORY_GRADIENT: Record<CategoryClass, [string, string]> = {
  sales: ['#fb923c', '#ea580c'],
  productivity: ['#60a5fa', '#2563eb'],
  training: ['#4ade80', '#16a34a'],
  hiring: ['#c084fc', '#9333ea'],
};

/** Deterministic gradient angle (90..300) from a stable key, so each entity differs. */
export function gradientAngle(key: string): number {
  return 90 + (hash(key) % 8) * 30;
}
