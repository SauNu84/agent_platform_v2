'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useState, useCallback } from 'react';

interface Props { defaultValue?: string; totalCount: number; }

/** Course Library search box — mirrors the Scenario Library's LibrarySearch (SAU-247). */
export default function CoursesSearch({ defaultValue = '', totalCount }: Props) {
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
        placeholder={`Search courses... (${totalCount})`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          push(e.target.value);
        }}
        aria-label="Search courses"
      />
      {value && (
        <button className="search-clear" onClick={() => { setValue(''); push(''); }} aria-label="Clear search">×</button>
      )}
    </div>
  );
}
