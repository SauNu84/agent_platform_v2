'use client';

import { useEffect } from 'react';
import { track } from '@/lib/track';

/**
 * Fires a single `landing_view` event when the Proviso landing page mounts
 * (SAU-349). Rendered once near the top of the page. Client-only; the page
 * itself stays a server component.
 */
export default function ProvisoTracking() {
  useEffect(() => {
    track('landing_view', { page: 'proviso' });
  }, []);
  return null;
}
