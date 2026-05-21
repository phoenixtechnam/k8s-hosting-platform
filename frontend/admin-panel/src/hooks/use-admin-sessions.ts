/**
 * Admin user session management — Security Hub → Identity & Sessions.
 *
 *   GET    /admin/users/:userId/sessions             — list active sessions
 *   DELETE /admin/users/:userId/sessions/:sessionId  — revoke one
 *   DELETE /admin/users/:userId/sessions             — bulk revoke all
 *   GET    /auth/me/sessions                          — caller's own list +
 *                                                       currentSessionId
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ActiveSession {
  readonly id: string;
  readonly userId: string;
  readonly panel: 'admin' | 'tenant';
  readonly tenantId: string | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
}

interface ListSessionsResponse {
  readonly data: { readonly sessions: ReadonlyArray<ActiveSession> };
}

interface MeSessionsResponse {
  readonly data: {
    readonly sessions: ReadonlyArray<ActiveSession>;
    readonly currentSessionId: string | null;
  };
}

const userSessionsKey = (userId: string) => ['admin-sessions', userId] as const;
const meSessionsKey = ['me-sessions'] as const;

export function useUserSessions(userId: string | null) {
  return useQuery({
    queryKey: userSessionsKey(userId ?? ''),
    enabled: !!userId,
    queryFn: async (): Promise<ReadonlyArray<ActiveSession>> => {
      if (!userId) return [];
      const body = await apiFetch<ListSessionsResponse>(
        `/api/v1/admin/users/${encodeURIComponent(userId)}/sessions`,
      );
      return body.data.sessions;
    },
    // Refresh on a moderate cadence so the operator sees newly-issued
    // sessions show up (e.g. a user logging in from another device).
    refetchInterval: 30_000,
  });
}

export function useMeSessions() {
  return useQuery({
    queryKey: meSessionsKey,
    queryFn: async () => {
      const body = await apiFetch<MeSessionsResponse>('/api/v1/auth/me/sessions');
      return body.data;
    },
    refetchInterval: 30_000,
  });
}

export function useRevokeSession(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch(
        `/api/v1/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: userSessionsKey(userId) });
      void qc.invalidateQueries({ queryKey: meSessionsKey });
    },
  });
}

export function useBulkRevokeSessions(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/admin/users/${encodeURIComponent(userId)}/sessions`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: userSessionsKey(userId) });
      void qc.invalidateQueries({ queryKey: meSessionsKey });
    },
  });
}
