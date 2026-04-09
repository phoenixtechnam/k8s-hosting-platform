import { useState, useMemo } from 'react';
import {
  Bell,
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle,
  Check,
  Trash2,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useNotifications,
  useMarkNotificationsRead,
  useDeleteNotification,
  type NotificationEntry,
} from '@/hooks/use-notifications';
import { formatRelativeTime } from '@/lib/format-relative-time';

/**
 * Round-4 Phase E: dedicated Notifications center page.
 *
 * Backed by the same hooks as the header dropdown but exposes a
 * larger limit, type filters, and per-row actions (mark-read,
 * delete). Linked from the dropdown's "View all" affordance and
 * the sidebar.
 */
type FilterType = 'all' | 'info' | 'warning' | 'error' | 'success';
type FilterRead = 'all' | 'unread' | 'read';

const typeIcons = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  success: CheckCircle,
} as const;

const typeColors = {
  info: 'text-blue-500 dark:text-blue-400',
  warning: 'text-amber-500 dark:text-amber-400',
  error: 'text-red-500 dark:text-red-400',
  success: 'text-green-500 dark:text-green-400',
} as const;

export default function Notifications() {
  // Round-4 Phase E: hardcoded limit=100. The notifications API
  // doesn't yet support pagination cursors — when it does, we'll
  // wire infinite scroll here.
  const { data, isLoading, isError } = useNotifications(100);
  const markRead = useMarkNotificationsRead();
  const deleteOne = useDeleteNotification();

  const [filterType, setFilterType] = useState<FilterType>('all');
  const [filterRead, setFilterRead] = useState<FilterRead>('all');

  const items = data?.data ?? [];

  const filtered = useMemo(() => {
    return items.filter((n) => {
      if (filterType !== 'all' && n.type !== filterType) return false;
      if (filterRead === 'unread' && n.isRead !== 0) return false;
      if (filterRead === 'read' && n.isRead === 0) return false;
      return true;
    });
  }, [items, filterType, filterRead]);

  const unreadInFiltered = filtered.filter((n) => n.isRead === 0);

  const handleMarkAllRead = () => {
    const ids = unreadInFiltered.map((n) => n.id);
    if (ids.length === 0) return;
    markRead.mutate(ids);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Bell size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="notifications-heading">
          Notifications
        </h1>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Full history of platform notifications for this account. New events
        also appear in the bell menu in the page header.
      </p>

      {/* Filters */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
        data-testid="notifications-filters"
      >
        <div>
          <label htmlFor="notif-type" className="mr-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            Type
          </label>
          <select
            id="notif-type"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as FilterType)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-700 dark:text-gray-200"
            data-testid="filter-type"
          >
            <option value="all">All types</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
            <option value="success">Success</option>
          </select>
        </div>
        <div>
          <label htmlFor="notif-read" className="mr-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            Read state
          </label>
          <select
            id="notif-read"
            value={filterRead}
            onChange={(e) => setFilterRead(e.target.value as FilterRead)}
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-700 dark:text-gray-200"
            data-testid="filter-read"
          >
            <option value="all">All</option>
            <option value="unread">Unread only</option>
            <option value="read">Read only</option>
          </select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="notifications-count">
            {filtered.length} shown · {unreadInFiltered.length} unread
          </span>
          {unreadInFiltered.length > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={markRead.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              data-testid="mark-all-read-button"
            >
              <Check size={12} /> Mark all as read
            </button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-brand-500" />
        </div>
      )}

      {!isLoading && isError && (
        <div className="rounded-xl border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-5 py-4 text-sm text-red-700 dark:text-red-300">
          Failed to load notifications.
        </div>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <div
          className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-5 py-12 text-center"
          data-testid="notifications-empty"
        >
          <Bell size={36} className="mx-auto text-gray-300 dark:text-gray-600" />
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {filterType !== 'all' || filterRead !== 'all'
              ? 'No notifications match the current filters.'
              : 'No notifications yet.'}
          </p>
        </div>
      )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div
          className="divide-y divide-gray-100 dark:divide-gray-700 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm"
          data-testid="notifications-list"
        >
          {filtered.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              onMarkRead={() => markRead.mutate([n.id])}
              onDelete={() => deleteOne.mutate(n.id)}
              markReadPending={markRead.isPending && Array.isArray(markRead.variables) && markRead.variables.includes(n.id)}
              deletePending={deleteOne.isPending && deleteOne.variables === n.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  onMarkRead,
  onDelete,
  markReadPending,
  deletePending,
}: {
  readonly notification: NotificationEntry;
  readonly onMarkRead: () => void;
  readonly onDelete: () => void;
  readonly markReadPending: boolean;
  readonly deletePending: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const Icon = typeIcons[notification.type] ?? Info;
  const color = typeColors[notification.type] ?? 'text-gray-400';
  const isUnread = notification.isRead === 0;

  return (
    <div
      className={clsx(
        'flex items-start gap-3 px-5 py-4',
        isUnread && 'bg-brand-50/30 dark:bg-brand-900/10',
      )}
      data-testid={`notification-${notification.id}`}
    >
      <Icon size={18} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {notification.title}
          </p>
          {isUnread && (
            <span className="inline-flex items-center rounded-full bg-brand-100 dark:bg-brand-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:text-brand-300">
              new
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{notification.message}</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          {formatRelativeTime(notification.createdAt)}
          {notification.resourceType && (
            <span className="ml-2 inline-flex items-center rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-mono">
              {notification.resourceType}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {isUnread && !confirmingDelete && (
          <button
            type="button"
            onClick={onMarkRead}
            disabled={markReadPending}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-brand-500 disabled:opacity-50"
            aria-label="Mark as read"
            title="Mark as read"
            data-testid={`mark-read-${notification.id}`}
          >
            <Check size={14} />
          </button>
        )}
        {confirmingDelete ? (
          <div className="flex items-center gap-1" data-testid={`confirm-delete-${notification.id}`}>
            <button
              type="button"
              onClick={() => {
                onDelete();
                setConfirmingDelete(false);
              }}
              disabled={deletePending}
              className="rounded-md bg-red-500 px-2 py-1 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
              data-testid={`confirm-delete-confirm-${notification.id}`}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={deletePending}
              className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              data-testid={`confirm-delete-cancel-${notification.id}`}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={deletePending}
            className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 disabled:opacity-50"
            aria-label="Delete notification"
            title="Delete notification"
            data-testid={`delete-notification-${notification.id}`}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
