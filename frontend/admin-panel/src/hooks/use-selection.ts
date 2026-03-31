import { useState, useCallback, useEffect } from 'react';

interface SelectableItem {
  readonly id: string;
}

interface UseSelectionResult<T extends SelectableItem> {
  readonly selectedIds: ReadonlySet<string>;
  readonly selectedCount: number;
  readonly isSelected: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly selectAll: (items: readonly T[]) => void;
  readonly deselectAll: () => void;
  readonly isAllSelected: (items: readonly T[]) => boolean;
  readonly isIndeterminate: (items: readonly T[]) => boolean;
}

export function useSelection<T extends SelectableItem>(resetKey?: unknown): UseSelectionResult<T> {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  // Reset when key changes
  useEffect(() => {
    setSelectedIds(new Set());
  }, [resetKey]);

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((items: readonly T[]) => {
    setSelectedIds(new Set(items.map(i => i.id)));
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  const isAllSelected = useCallback(
    (items: readonly T[]) => items.length > 0 && items.every(i => selectedIds.has(i.id)),
    [selectedIds],
  );

  const isIndeterminate = useCallback(
    (items: readonly T[]) => {
      const count = items.filter(i => selectedIds.has(i.id)).length;
      return count > 0 && count < items.length;
    },
    [selectedIds],
  );

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    isSelected,
    toggle,
    selectAll,
    deselectAll,
    isAllSelected,
    isIndeterminate,
  };
}
