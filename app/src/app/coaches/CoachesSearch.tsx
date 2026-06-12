'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useState, useCallback } from 'react';

interface Props { defaultValue?: string; totalCount: number; }

/** Coach Library search box — mirrors the Course Library's CoursesSearch (SAU-249). */
export default function CoachesSearch({ defaultValue = '', totalCount }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [value, setValue] = useState(defaultValue);

  const push = useCallback((q: string) => {
    const params = new URLSearchParams(sp.toString());
    if (q) params.set('q', q);
    else params.delete('q');
    router.push(`${pathname}?${params.toString()}`);
  }, [router, pathname, sp]);

  return (
    <div className="search-wrap">
      <span className="search-icon">⌕</span>
      <input
        type="search"
        className="search-input"
        placeholder={`Search coaches... (${totalCount})`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          push(e.target.value);
        }}
        aria-label="Search coaches"
      />
      {value && (
        <button className="search-clear" onClick={() => { setValue(''); push(''); }} aria-label="Clear search">×</button>
      )}
    </div>
  );
}
