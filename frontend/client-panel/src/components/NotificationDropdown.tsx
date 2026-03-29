import { useState, useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '@/hooks/use-notifications';

export default function NotificationDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useNotifications();

  const notifications = data ?? [];
  const count = notifications.length;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="relative rounded-md p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200"
        aria-label="Notifications"
        data-testid="notification-bell"
      >
        <Bell size={20} />
        {count > 0 && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50"
          data-testid="notification-dropdown"
        >
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
          </div>

          <div className="max-h-72 overflow-y-auto">
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              No new notifications
            </div>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-700 px-4 py-2">
            <span className="block w-full rounded-lg py-1.5 text-center text-xs font-medium text-gray-300 cursor-not-allowed">
              View all
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
