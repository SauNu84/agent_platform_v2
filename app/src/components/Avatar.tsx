/**
 * Deterministic monogram avatar (SAU-217, design call #3).
 *
 * Curated, no live AI image-gen and no photoreal faces: a styled monogram on a
 * per-category gradient, keyed by category + slug so the same entity always gets
 * the same identity. This is the "upgraded styled generator beyond today's flat
 * gradient" the design direction asked for — the gradient hue matches the colored
 * category tag, and the angle is derived deterministically from the slug.
 */
import { categoryClass, CATEGORY_GRADIENT, gradientAngle } from '@/lib/category';

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  category,
  slug,
  size = 48,
}: {
  name: string;
  category: string;
  slug?: string;
  size?: number;
}) {
  const [from, to] = CATEGORY_GRADIENT[categoryClass(category)];
  const angle = gradientAngle(slug ?? name);
  return (
    <div
      className="avatar-monogram"
      style={{ width: size, height: size, background: `linear-gradient(${angle}deg, ${from}, ${to})` }}
      aria-hidden="true"
    >
      <span>{monogram(name)}</span>
    </div>
  );
}
