import clsx from 'clsx';
import type { ReactNode } from 'react';

interface BulkActionBarProps {
  readonly selectedCount: number;
  readonly onDeselectAll: () => void;
  readonly children: ReactNode;
}

export default function BulkActionBar({
  selectedCount,
  onDeselectAll,
  children,
}: BulkActionBarProps) {
  return (
    <div
      className={clsx(
        'fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-200 ease-in-out',
        selectedCount > 0 ? 'translate-y-0' : 'translate-y-full',
      )}
      data-testid="bulk-action-bar"
    >
      <div className="mx-auto max-w-7xl px-4 py-3">
        <div
          className={clsx(
            'flex items-center justify-between rounded-lg px-4 py-3 shadow-lg',
            'bg-gray-900 text-white',
            'dark:bg-gray-800 dark:text-white',
          )}
        >
          {/* Left: count + deselect */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium" data-testid="bulk-selected-count">
              {selectedCount} selected
            </span>
            <button
              type="button"
              onClick={onDeselectAll}
              className={clsx(
                'text-sm underline transition-colors',
                'text-gray-300 hover:text-white',
                'dark:text-gray-400 dark:hover:text-white',
              )}
              data-testid="bulk-deselect-all"
            >
              Deselect All
            </button>
          </div>

          {/* Right: action buttons */}
          <div className="flex items-center gap-2">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SelectCheckboxProps {
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly onChange: () => void;
}

export function SelectCheckbox({ checked, indeterminate, onChange }: SelectCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      onClick={onChange}
      className={clsx(
        'flex h-4 w-4 items-center justify-center rounded border transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1',
        'dark:focus:ring-offset-gray-800',
        checked || indeterminate
          ? 'border-blue-600 bg-blue-600 dark:border-blue-500 dark:bg-blue-500'
          : 'border-gray-300 bg-white hover:border-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-gray-500',
      )}
      data-testid="select-checkbox"
    >
      {checked && !indeterminate && (
        <svg
          className="h-3 w-3 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
      {indeterminate && (
        <svg
          className="h-3 w-3 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
        </svg>
      )}
    </button>
  );
}
