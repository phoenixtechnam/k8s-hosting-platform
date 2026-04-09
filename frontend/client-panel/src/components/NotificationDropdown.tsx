import { useState, useEffect, useRef } from 'react';
import { Bell, Info, AlertTriangle, XCircle, CheckCircle, Check } from 'lucide-react';
import {
  useNotifications,
  useUnreadCount,
  useMarkNotificationsRead,
  type NotificationEntry,
} from '@/hooks/use-notifications';
import { formatRelativeTime } from '@/lib/format-relative-time';

const typeIcons = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  success: CheckCircle,
} as const;

const typeColors = {
  info: 'text-blue-400',
  warning: 'text-amber-400',
  error: 'text-red-400',
  success: 'text-green-400',
} as const;

export default function NotificationDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useNotifications(10);
  const { data: unreadData } = useUnreadCount();
  const markRead = useMarkNotificationsRead();

  const notifications: readonly NotificationEntry[] = data?.data ?? [];
  const unreadCount = unreadData?.data?.count ?? 0;

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

  const handleMarkAllRead = () => {
    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length > 0) {
      markRead.mutate(unreadIds);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative rounded-md p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200"
        aria-label="Notifications"
        data-testid="notification-bell"
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50"
          data-testid="notification-dropdown"
        >
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <>
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-900 dark:text-brand-300">
                    {unreadCount}
                  </span>
                  <button
                    type="button"
                    onClick={handleMarkAllRead}
                    className="rounded p-1 text-gray-400 hover:text-brand-500"
                    title="Mark all as read"
                    data-testid="mark-all-read"
                  >
                    <Check size={14} />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {isLoading && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Loading...</div>
            )}
            {!isLoading && notifications.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-400 dark:text-gray-500">
                No new notifications
              </div>
            )}
            {!isLoading
              && notifications.map((item) => {
                const Icon = typeIcons[item.type] ?? Info;
                const color = typeColors[item.type] ?? 'text-gray-400';
                return (
                  <div
                    key={item.id}
                    className={`flex items-start gap-3 border-b border-gray-50 px-4 py-3 last:border-b-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-750 ${
                      !item.isRead ? 'bg-brand-50/30 dark:bg-brand-900/10' : ''
                    }`}
                  >
                    <Icon size={16} className={`mt-0.5 shrink-0 ${color}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{item.message}</p>
                      <p className="mt-0.5 text-xs text-gray-400">{formatRelativeTime(item.createdAt)}</p>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
