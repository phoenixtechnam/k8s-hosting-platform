import { Info } from 'lucide-react';

/**
 * Phase 6: shared banner shown at the top of mutable pages for
 * `client_user` accounts. The backend already rejects writes from
 * this role via `requireClientRoleByMethod` middleware — this
 * notice explains why the buttons are missing.
 */
export default function ReadOnlyNotice({
  message = 'You have read-only access to this section. Only administrators can make changes. Contact a client admin to request changes.',
}: { readonly message?: string } = {}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-sm text-blue-700 dark:text-blue-300"
      data-testid="read-only-notice"
    >
      <Info size={16} className="mt-0.5 shrink-0" />
      <div>{message}</div>
    </div>
  );
}
