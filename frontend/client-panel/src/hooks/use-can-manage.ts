import { useAuth } from '@/hooks/use-auth';

/**
 * Phase 6: returns `true` when the current client-panel user has
 * write permissions on client resources (domains, deployments,
 * cron-jobs, ssh-keys, backups, email, etc.). This is `true` for
 * `client_admin` and for staff tokens that impersonated into the
 * client panel (`super_admin`, `admin`, `support`).
 *
 * Use this to hide buttons that would otherwise 403 on click.
 * The backend enforces the same rule via `requireClientRoleByMethod`
 * in `middleware/auth.ts` — the frontend gate is UX polish, not
 * the security boundary.
 */
export function useCanManage(): boolean {
  const user = useAuth((s) => s.user);
  if (!user?.role) return false;
  return (
    user.role === 'client_admin'
    || user.role === 'super_admin'
    || user.role === 'admin'
    || user.role === 'support'
  );
}
