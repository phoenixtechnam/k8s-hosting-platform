import clsx from 'clsx';

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

interface PaginationBarProps {
  readonly totalCount: number;
  readonly pageSize: number;
  readonly pageIndex: number;
  readonly hasPrevPage: boolean;
  readonly hasNextPage: boolean;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onPageSizeChange: (size: number) => void;
}

export default function PaginationBar({
  totalCount,
  pageSize,
  pageIndex,
  hasPrevPage,
  hasNextPage,
  onNext,
  onPrev,
  onPageSizeChange,
}: PaginationBarProps) {
  const rangeStart = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const rangeEnd = Math.min(rangeStart + pageSize - 1, totalCount);

  return (
    <div
      className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
      data-testid="pagination-bar"
    >
      {/* Left: range text */}
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Showing{' '}
        <span className="font-medium">{rangeStart}</span>
        {'-'}
        <span className="font-medium">{rangeEnd}</span>
        {' of '}
        <span className="font-medium">{totalCount}</span>
      </p>

      {/* Center: page size dropdown */}
      <div className="flex items-center gap-2">
        <label
          htmlFor="page-size-select"
          className="text-sm text-gray-600 dark:text-gray-400"
        >
          Rows per page:
        </label>
        <select
          id="page-size-select"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className={clsx(
            'rounded border border-gray-300 bg-white px-2 py-1 text-sm',
            'focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500',
            'dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200',
            'dark:focus:border-blue-400 dark:focus:ring-blue-400',
          )}
          data-testid="page-size-select"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      {/* Right: prev/next buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!hasPrevPage}
          onClick={onPrev}
          className={clsx(
            'rounded border px-3 py-1.5 text-sm font-medium transition-colors',
            hasPrevPage
              ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-600',
          )}
          data-testid="pagination-prev"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!hasNextPage}
          onClick={onNext}
          className={clsx(
            'rounded border px-3 py-1.5 text-sm font-medium transition-colors',
            hasNextPage
              ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              : 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-600',
          )}
          data-testid="pagination-next"
        >
          Next
        </button>
      </div>
    </div>
  );
}
