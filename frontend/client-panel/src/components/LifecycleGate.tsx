import { Ban, Archive, Loader2 } from 'lucide-react';
import { useMyLifecycle } from '@/hooks/use-my-lifecycle';

/**
 * Route wrapper that replaces destructive pages (Files, Applications,
 * CronJobs, DatabaseManager, Backups) with a read-only placeholder
 * while the account is suspended/archived or a storage op is running.
 *
 * Dashboard + Notifications + UserSettings are intentionally exempt —
 * the customer can still see their account state and update their
 * profile even during a suspend.
 */
export default function LifecycleGate({ children }: { readonly children: React.ReactNode }) {
  const { data } = useMyLifecycle();
  if (!data) return <>{children}</>;

  const { clientStatus, storageLifecycleState } = data;

  if (clientStatus === 'suspended') {
    return (
      <Placeholder
        icon={<Ban size={40} className="text-red-500" />}
        title="Account suspended"
        body="This feature is unavailable while your account is suspended. Other features remain read-only."
      />
    );
  }
  if (clientStatus === 'archived') {
    return (
      <Placeholder
        icon={<Archive size={40} className="text-gray-500" />}
        title="Account archived"
        body="Your data has been archived. Contact support to restore the account before using this feature."
      />
    );
  }
  if (storageLifecycleState && storageLifecycleState !== 'idle' && storageLifecycleState !== 'failed') {
    return (
      <Placeholder
        icon={<Loader2 size={40} className="animate-spin text-blue-500" />}
        title="Maintenance in progress"
        body="Your storage is being serviced — this typically finishes within a few minutes. Try again once the banner at the top disappears."
      />
    );
  }
  return <>{children}</>;
}

function Placeholder({ icon, title, body }: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 py-20 text-center"
      data-testid="lifecycle-gate-blocked"
    >
      {icon}
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">{body}</p>
    </div>
  );
}
