/**
 * Course cover banner (SAU-247, board request: cover image setting).
 *
 * If the course sets a `coverImageUrl`, we render it as a banner. Otherwise we
 * fall back to a deterministic, curated gradient cover with the course monogram
 * — the same no-image-gen visual system as the scenario Avatar (SAU-217), so the
 * Course Library always reads as visual & attractive even before authors upload
 * art. The gradient hue + angle are derived from the slug, so a course always
 * gets the same cover.
 */
import { categoryClass, CATEGORY_GRADIENT, gradientAngle } from '@/lib/category';

function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function isHttpUrl(v: string | null | undefined): v is string {
  return !!v && /^https?:\/\//.test(v);
}

export function CourseCover({
  name,
  slug,
  coverImageUrl,
  height = 130,
  rounded = true,
}: {
  name: string;
  slug: string;
  coverImageUrl?: string | null;
  height?: number;
  rounded?: boolean;
}) {
  const radius = rounded ? 8 : 0;
  if (isHttpUrl(coverImageUrl)) {
    return (
      <div className="course-cover" style={{ height, borderRadius: radius, overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={coverImageUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
    );
  }
  const [from, to] = CATEGORY_GRADIENT[categoryClass(slug)];
  const angle = gradientAngle(slug);
  return (
    <div
      className="course-cover course-cover--gradient"
      aria-hidden="true"
      style={{
        height,
        borderRadius: radius,
        background: `linear-gradient(${angle}deg, ${from}, ${to})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        style={{
          color: 'rgba(255,255,255,0.92)',
          fontWeight: 700,
          fontSize: Math.round(height / 3),
          letterSpacing: 1,
          textShadow: '0 1px 2px rgba(0,0,0,0.18)',
        }}
      >
        {monogram(name)}
      </span>
    </div>
  );
}
