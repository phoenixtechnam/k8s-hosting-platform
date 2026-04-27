import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Server, HardDrive, Layers } from 'lucide-react';
import clsx from 'clsx';
import ClusterNodes from '@/pages/ClusterNodes';
import StorageSettings from '@/pages/StorageSettings';
import PlatformStoragePolicyCard from '@/components/PlatformStoragePolicyCard';

type TabKey = 'nodes' | 'storage' | 'ha';

const TABS: ReadonlyArray<{
  readonly key: TabKey;
  readonly label: string;
  readonly icon: typeof Server;
  readonly hint: string;
}> = [
  {
    key: 'nodes',
    label: 'Cluster Nodes',
    icon: Server,
    hint: 'Server/worker role + host-client-workloads opt-in',
  },
  {
    key: 'storage',
    label: 'Storage',
    icon: HardDrive,
    hint: 'Longhorn dashboard + active backup target',
  },
  {
    key: 'ha',
    label: 'HA Settings',
    icon: Layers,
    hint: 'Platform storage replication tier (Local ↔ HA)',
  },
];

const VALID_TABS: ReadonlySet<TabKey> = new Set(['nodes', 'storage', 'ha']);

/**
 * Combined "Nodes & Storage" admin page.
 *
 * The two surfaces — cluster node administration and platform storage
 * configuration — sit close together operationally (HA tier depends
 * on having ≥3 server-labelled nodes; Longhorn replica count is set
 * per-tier; node loss directly affects volume health). Joining them
 * under one page with tabs reduces the trip count for operators
 * during incidents.
 *
 * The active tab is reflected in the URL (`?tab=nodes` or
 * `?tab=storage`) so deep links and the browser back button work as
 * expected. The legacy routes `/settings/nodes` and `/settings/storage`
 * still work and are wired in App.tsx to redirect here with the
 * correct tab pre-selected.
 */
export default function NodesAndStorage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab: TabKey = useMemo(() => {
    if (requested && VALID_TABS.has(requested as TabKey)) return requested as TabKey;
    return 'nodes';
  }, [requested]);

  const setActiveTab = (key: TabKey): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6" data-testid="nodes-and-storage-page">
      <div className="flex items-center gap-3">
        <Server size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Nodes &amp; Storage</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Cluster node roles and persistent storage configuration. Use the tabs to switch
            between node administration and storage policy / backup targets.
          </p>
        </div>
      </div>

      <div
        className="flex gap-1 border-b border-gray-200 dark:border-gray-700"
        role="tablist"
        aria-label="Nodes and Storage sections"
      >
        {TABS.map(({ key, label, icon: Icon, hint }) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`nodes-and-storage-panel-${key}`}
              id={`nodes-and-storage-tab-${key}`}
              data-testid={`tab-${key}`}
              title={hint}
              onClick={() => setActiveTab(key)}
              className={clsx(
                'flex items-center gap-2 -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
              )}
            >
              <Icon size={16} />
              {label}
            </button>
          );
        })}
      </div>

      {activeTab === 'nodes' && (
        <div
          role="tabpanel"
          id="nodes-and-storage-panel-nodes"
          aria-labelledby="nodes-and-storage-tab-nodes"
        >
          <ClusterNodes embedded />
        </div>
      )}
      {activeTab === 'storage' && (
        <div
          role="tabpanel"
          id="nodes-and-storage-panel-storage"
          aria-labelledby="nodes-and-storage-tab-storage"
        >
          <StorageSettings embedded />
        </div>
      )}
      {activeTab === 'ha' && (
        <div
          role="tabpanel"
          id="nodes-and-storage-panel-ha"
          aria-labelledby="nodes-and-storage-tab-ha"
          className="space-y-6"
          data-testid="ha-settings-tab"
        >
          <PlatformStoragePolicyCard />
        </div>
      )}
    </div>
  );
}
