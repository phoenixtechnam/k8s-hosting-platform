import { useAuth } from '@/hooks/use-auth';

/**
 * Returns the current client context from the authenticated user's JWT claims.
 * Client panel users have a clientId in their token.
 */
export function useClientContext() {
  const { user, isLoading } = useAuth();

  return {
    clientId: user?.clientId ?? null,
    clientName: user?.fullName ?? null,
    isLoading,
  };
}
