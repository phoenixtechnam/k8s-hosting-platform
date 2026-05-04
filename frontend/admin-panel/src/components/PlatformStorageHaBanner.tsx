import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Rocket, X } from 'lucide-react';
import { usePlatformStoragePolicy } from '@/hooks/use-platform-storage-policy';

// sessionStorage key — bumped if banner copy/scope changes so old
// dismissals don't suppress a meaningfully-different recommendation.
const DISMISS_KEY = 'platform-storage-ha-banner-dismissed-v3';

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
      className="mx-4 mt-4 lg:mx-6 lg:mt-6 rounded-lg border border-purple-300 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 px-4 py-3"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2 text-sm text-purple-800 dark:text-purple-200">
          <Rocket size={16} className="mt-0.5 shrink-0 text-purple-500 dark:text-purple-400" />
          <span>
            <strong>Cluster reached HA size.</strong>
            <br />
            {clusterState.readyServerCount} of {clusterState.totalNodeCount} server nodes are in{' '}
            <strong>Ready state</strong>. Switch to <strong>High Availability Mode</strong> to
            replicate platform volumes (System DB + Mail DB) and scale platform services to
            survive server node loss and enable <strong>Load Balancing</strong>. Reversible —
            switch back to <strong>Local Mode</strong> anytime.
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            to="/nodes-and-storage?tab=ha"
            data-testid="platform-storage-ha-banner-link"
            className="text-sm font-medium underline text-purple-800 dark:text-purple-200"
          >
            Cluster Settings
          </Link>
          <button
            type="button"
            data-testid="platform-storage-ha-banner-dismiss"
            onClick={onDismiss}
            className="rounded-md p-1 text-purple-600 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            aria-label="Dismiss HA recommendation"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
