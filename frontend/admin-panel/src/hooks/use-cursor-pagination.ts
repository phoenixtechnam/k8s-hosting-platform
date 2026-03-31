import { useState, useCallback } from 'react';

interface CursorPaginationOptions {
  readonly defaultLimit?: number;
}

interface CursorPaginationState {
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly pageIndex: number;
  readonly hasPrevPage: boolean;
  readonly goNext: (nextCursor: string) => void;
  readonly goPrev: () => void;
  readonly resetPagination: () => void;
  readonly setPageSize: (size: number) => void;
}

export function useCursorPagination(options: CursorPaginationOptions = {}): CursorPaginationState {
  const { defaultLimit = 20 } = options;
  const [limit, setLimit] = useState(defaultLimit);
  const [cursorStack, setCursorStack] = useState<readonly string[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined);

  const resetPagination = useCallback(() => {
    setCurrentCursor(undefined);
    setCursorStack([]);
  }, []);

  const goNext = useCallback((nextCursor: string) => {
    setCursorStack(prev =>
      currentCursor !== undefined ? [...prev, currentCursor] : prev,
    );
    setCurrentCursor(nextCursor);
  }, [currentCursor]);

  const goPrev = useCallback(() => {
    setCursorStack(prev => {
      const newStack = [...prev];
      const prevCursor = newStack.pop();
      setCurrentCursor(prevCursor);
      return newStack;
    });
  }, []);

  const setPageSize = useCallback((size: number) => {
    setLimit(size);
    resetPagination();
  }, [resetPagination]);

  return {
    cursor: currentCursor,
    limit,
    pageIndex: cursorStack.length,
    hasPrevPage: cursorStack.length > 0,
    goNext,
    goPrev,
    resetPagination,
    setPageSize,
  };
}
