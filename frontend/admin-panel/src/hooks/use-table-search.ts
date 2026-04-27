import { useMemo, useState } from 'react';

/**
 * Simple table search hook — case-insensitive substring match across
 * the named keys of each row. Used by the admin Deployments tab,
 * Storage Lifecycle PVC list, and Installed Applications table so
 * each gets the same UX without re-implementing a filter for every
 * page.
 */
export function useTableSearch<T extends object>(
  data: readonly T[],
  searchKeys: ReadonlyArray<keyof T>,
  initial = '',
): {
  readonly query: string;
  readonly setQuery: (value: string) => void;
  readonly filteredData: readonly T[];
} {
  const [query, setQuery] = useState(initial);
  const filteredData = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((row) => {
      for (const key of searchKeys) {
        const v = row[key];
        if (v == null) continue;
        if (String(v).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [data, query, searchKeys]);
  return { query, setQuery, filteredData };
}
