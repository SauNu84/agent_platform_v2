'use client';

import Link from 'next/link';
import type { TrackEvent, TrackProps } from '@/lib/track';
import { track } from '@/lib/track';

/**
 * A link/anchor that emits a marketing event on click before navigating
 * (SAU-349). Used for the design-partner CTA and per-archetype CTAs so WS5
 * (SAU-350) can attribute demand by source. Renders a plain <a> for external /
 * mailto targets and a Next <Link> for in-app routes.
 */
export default function TrackedLink({
  href,
  event,
  props,
  className,
  children,
}: {
  href: string;
  event: TrackEvent;
  props?: TrackProps;
  className?: string;
  children: React.ReactNode;
}) {
  const onClick = () => track(event, props);
  const external = href.startsWith('mailto:') || href.startsWith('http') || href.startsWith('#');
  if (external) {
    return (
      <a href={href} className={className} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}
