import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, X } from 'lucide-react';
import { usePlatformStoragePolicy } from '@/hooks/use-platform-storage-policy';

// sessionStorage key — bumped if banner copy/scope changes so old
// dismissals don't suppress a meaningfully-different recommendation.
const DISMISS_KEY = 'platform-storage-ha-banner-dismissed-v1';

// Recommendation banner shown across every admin page when the cluster
// has reached HA size (>=3 Ready servers) but platform storage is still
// at 1 replica. Manual opt-in only — admin clicks through to Storage
// Settings and applies the policy. Disappears once HA is applied OR
// the operator pins local (pinnedByAdmin=true).
export default function PlatformStorageHaBanner() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.sessionStorage.getItem(DISMISS_KEY) === '1'; }
    catch { return false; }
  });
  const { data } = usePlatformStoragePolicy();

  if (dismissed || !data?.data) return null;

  const { policy, clusterState } = data.data;
  const shouldShow =
    clusterState.recommendedTier === 'ha' &&
    policy.systemTier === 'local' &&
    !policy.pinnedByAdmin;

  if (!shouldShow) return null;

  const onDismiss = () => {
    try { window.sessionStorage.setItem(DISMISS_KEY, '1'); }
    catch { /* sessionStorage blocked (private mode, etc.) — fall back to in-memory */ }
    setDismissed(true);
  };

  return (
    <div
      data-testid="platform-storage-ha-banner"
      role="status"
      aria-live="polite"
      className="mx-4 mt-4 lg:mx-6 lg:mt-6 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
          <Database size={16} className="shrink-0 text-amber-500 dark:text-amber-400" />
          <span>
            <strong>Cluster reached HA size</strong>
            {' — '}
            {clusterState.readyServerCount} of {clusterState.totalNodeCount} nodes Ready. Promote
            platform storage to 3 replicas so postgres + stalwart-mail survive a single-node outage.
            Reversible anytime.
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            to="/settings/storage"
            data-testid="platform-storage-ha-banner-link"
            className="text-sm font-medium underline text-amber-800 dark:text-amber-200"
          >
            Storage Settings
          </Link>
          <button
            type="button"
            data-testid="platform-storage-ha-banner-dismiss"
            onClick={onDismiss}
            className="rounded-md p-1 text-amber-600 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label="Dismiss HA recommendation"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
