/**
 * SkeletonLoader — two stacked pulsing placeholders for loading
 * states. Extracted from PosturePage on 2026-05-21 so shared
 * components don't import from page modules.
 */
export function SkeletonLoader() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      <div className="h-48 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
    </div>
  );
}
