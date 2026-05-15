import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

/**
 * Generic collapsible section for the Email Management page.
 *
 * 2026-05-14 streamline UX: every operational area collapses to a
 * one-line summary so the operator can scan the page top-down and
 * only open the section they need. The pre-streamline layout dumped
 * 5+ heavy cards (300-800 lines each) inline; this wrapper changes
 * that to drill-down without rewriting the cards themselves.
 *
 * Sections that need persistence across reloads can pass `storageKey`
 * — opened/closed state is then mirrored to localStorage.
 */
interface MailSectionCardProps {
  readonly icon: ComponentType<{ size?: number; className?: string }>;
  readonly title: string;
  readonly summary?: ReactNode;
  /** Test-id for the toggle header. Body gets `${dataTestId}-body`. */
  readonly dataTestId: string;
  /** Default-open if true. */
  readonly defaultOpen?: boolean;
  /** Persist open/closed in localStorage under this key. */
  readonly storageKey?: string;
  readonly children: ReactNode;
}

export default function MailSectionCard({
  icon: Icon,
  title,
  summary,
  dataTestId,
  defaultOpen = false,
  storageKey,
  children,
}: MailSectionCardProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (!storageKey) return defaultOpen;
    try {
      const v = localStorage.getItem(`mail-section:${storageKey}`);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch { /* ignore */ }
    return defaultOpen;
  });

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (storageKey) {
      try {
        localStorage.setItem(`mail-section:${storageKey}`, next ? '1' : '0');
      } catch { /* ignore */ }
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40"
        data-testid={dataTestId}
        aria-expanded={open}
      >
        <Icon size={18} className="text-gray-600 dark:text-gray-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</div>
          {summary && (
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{summary}</div>
          )}
        </div>
        {open
          ? <ChevronDown size={14} className="text-gray-400 shrink-0" />
          : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
      </button>
      {open && (
        <div
          className="border-t border-gray-100 dark:border-gray-700 px-4 py-4 space-y-4"
          data-testid={`${dataTestId}-body`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
