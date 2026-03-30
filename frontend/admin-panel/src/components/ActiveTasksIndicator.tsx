import { useState, useRef, useEffect } from 'react';
import { Loader2, ChevronRight } from 'lucide-react';
import { useActiveTasks } from '@/hooks/use-provisioning';

interface ActiveTasksIndicatorProps {
  readonly onOpenTask?: (clientId: string) => void;
}

export default function ActiveTasksIndicator({ onOpenTask }: ActiveTasksIndicatorProps) {
  const { data } = useActiveTasks();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!data || data.count === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="relative flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-900/30 dark:text-brand-300 dark:hover:bg-brand-900/50"
        data-testid="active-tasks-indicator"
      >
        <Loader2 size={14} className="animate-spin" />
        <span>{data.count} task{data.count !== 1 ? 's' : ''}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-gray-200 bg-white shadow-lg z-50 dark:border-gray-700 dark:bg-gray-800"
          data-testid="active-tasks-dropdown"
        >
          <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Active Tasks
            </h3>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            {data.tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => {
                  setOpen(false);
                  onOpenTask?.(task.clientId);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid={`active-task-${task.id}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate dark:text-gray-100">
                    {task.companyName}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {task.currentStep ?? 'Starting...'} ({task.completedSteps}/{task.totalSteps})
                  </p>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600">
                    <div
                      className="h-1.5 rounded-full bg-brand-500 transition-all"
                      style={{ width: `${task.totalSteps > 0 ? (task.completedSteps / task.totalSteps) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <ChevronRight size={14} className="text-gray-400 dark:text-gray-500" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
