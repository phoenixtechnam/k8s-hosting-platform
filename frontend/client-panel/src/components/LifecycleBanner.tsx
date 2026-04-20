import { AlertTriangle, Ban, Archive, Loader2 } from 'lucide-react';
import { useMyLifecycle } from '@/hooks/use-my-lifecycle';

/**
 * Global banner that warns the customer about non-operational states
 * of their account. Renders nothing when everything is healthy and
 * the orchestrator is idle.
 *
 * State → message mapping:
 *   - clientStatus=suspended → red banner, destructive actions blocked
 *   - clientStatus=archived → gray banner, read-only access
 *   - storageLifecycleState != idle → blue banner, "operation in
 *     progress, some actions may appear slow or temporarily fail"
 */
export default function LifecycleBanner() {
  const { data } = useMyLifecycle();
  if (!data) return null;

  const { clientStatus, storageLifecycleState } = data;

  if (clientStatus === 'suspended') {
    return (
      <Banner tone="red" icon={<Ban size={16} />}>
        <strong>Your account is suspended.</strong> Your sites and services are unavailable until an admin re-activates the account. Contact support if you believe this is in error.
      </Banner>
    );
  }

  if (clientStatus === 'archived') {
    return (
      <Banner tone="gray" icon={<Archive size={16} />}>
        <strong>Your account is archived.</strong> Active services are stopped; data is retained on the snapshot store and can be restored on request.
      </Banner>
    );
  }

  if (storageLifecycleState && storageLifecycleState !== 'idle') {
    const label = storageLifecycleState === 'resizing' ? 'Resizing your storage'
      : storageLifecycleState === 'snapshotting' ? 'Creating a snapshot of your data'
      : storageLifecycleState === 'restoring' ? 'Restoring your data'
      : storageLifecycleState === 'archiving' ? 'Archiving your account'
      : storageLifecycleState === 'failed' ? 'A storage operation failed'
      : 'A storage operation is in progress';
    const tone = storageLifecycleState === 'failed' ? 'red' : 'blue';
    return (
      <Banner tone={tone} icon={tone === 'red' ? <AlertTriangle size={16} /> : <Loader2 size={16} className="animate-spin" />}>
        <strong>{label}.</strong> Some parts of the control panel may appear slow or return errors until the operation completes.
      </Banner>
    );
  }

  return null;
}

function Banner({ tone, icon, children }: {
  readonly tone: 'red' | 'gray' | 'blue';
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const toneClasses = tone === 'red'
    ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-200'
    : tone === 'blue'
      ? 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-200'
      : 'bg-gray-100 border-gray-200 text-gray-800 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200';
  return (
    <div
      role="alert"
      className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${toneClasses}`}
      data-testid="lifecycle-banner"
    >
      <span className="shrink-0">{icon}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
