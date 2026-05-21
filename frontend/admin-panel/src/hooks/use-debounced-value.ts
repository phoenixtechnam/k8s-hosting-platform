/**
 * useDebouncedValue — returns `value` delayed by `delayMs`. Hook
 * lives here (extracted from PosturePage on 2026-05-21) so multiple
 * consumers can import from a `hooks/` path rather than a `pages/`
 * path. The cross-layer import from `components/security/web-defense-
 * tabs.tsx` was an inverted dependency that's now resolved.
 */
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
