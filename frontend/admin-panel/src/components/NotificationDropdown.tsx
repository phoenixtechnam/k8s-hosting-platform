import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Activity } from 'lucide-react';
import { useNotifications } from '@/hooks/use-notifications';
import { formatRelativeTime } from '@/lib/format-relative-time';

export default function NotificationDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useNotifications(10);
  const navigate = useNavigate();

  const notifications = data?.data ?? [];
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
        className="relative rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
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
          className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-gray-200 bg-white shadow-lg z-50"
          data-testid="notification-dropdown"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
            {count > 0 && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                {count}
              </span>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {isLoading && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Loading...</div>
            )}
            {!isLoading && count === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">No notifications</div>
            )}
            {!isLoading &&
              notifications.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 border-b border-gray-50 px-4 py-3 last:border-b-0 hover:bg-gray-50"
                >
                  <Activity size={16} className="mt-0.5 shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-700">
                      {item.actionType} {item.resourceType}
                    </p>
                    <p className="text-xs text-gray-400">{formatRelativeTime(item.createdAt)}</p>
                  </div>
                </div>
              ))}
          </div>

          <div className="border-t border-gray-100 px-4 py-2">
            <button
              onClick={() => {
                setOpen(false);
                navigate('/monitoring');
              }}
              className="w-full rounded-lg py-1.5 text-center text-xs font-medium text-brand-600 hover:bg-brand-50"
              data-testid="notification-view-all"
            >
              View all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
