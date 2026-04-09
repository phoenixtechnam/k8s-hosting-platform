import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface NotificationEntry {
  readonly id: string;
  readonly userId: string;
  readonly type: 'info' | 'warning' | 'error' | 'success';
  readonly title: string;
  readonly message: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly isRead: number;
  readonly readAt: string | null;
  readonly createdAt: string;
}

interface NotificationsResponse {
  readonly data: readonly NotificationEntry[];
}

interface UnreadCountResponse {
  readonly data: { readonly count: number };
}

export function useNotifications(limit = 20, unreadOnly = false) {
  return useQuery({
    queryKey: ['notifications', limit, unreadOnly],
    queryFn: () => apiFetch<NotificationsResponse>(
      `/api/v1/notifications?limit=${limit}${unreadOnly ? '&unread_only=true' : ''}`,
    ),
    refetchInterval: 30_000,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ['notifications-unread-count'],
    queryFn: () => apiFetch<UnreadCountResponse>('/api/v1/notifications/unread-count'),
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>('/api/v1/notifications/mark-read', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/notifications/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}
