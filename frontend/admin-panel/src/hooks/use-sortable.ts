import { useState, useMemo } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

export interface UseSortableResult<T> {
  readonly sortedData: readonly T[];
  readonly sortKey: string;
  readonly sortDirection: SortDirection;
  readonly onSort: (key: string) => void;
}

function getValue(obj: unknown, key: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { sensitivity: 'base' });

  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

export function useSortable<T>(data: readonly T[], defaultKey: string, defaultDirection: SortDirection = 'asc'): UseSortableResult<T> {
  const [sort, setSort] = useState<SortState>({ key: defaultKey, direction: defaultDirection });

  const onSort = (key: string) => {
    setSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const sortedData = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const va = getValue(a, sort.key);
      const vb = getValue(b, sort.key);
      const result = compare(va, vb);
      return sort.direction === 'asc' ? result : -result;
    });
    return copy;
  }, [data, sort.key, sort.direction]);

  return { sortedData, sortKey: sort.key, sortDirection: sort.direction, onSort };
}
