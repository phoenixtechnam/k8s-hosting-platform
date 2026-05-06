/**
 * System Backup admin page.
 *
 * Scope: cluster-state recovery (secrets, system DBs, Stalwart BLOB,
 * Longhorn snapshots — NOT customer/tenant data, which is owned by
 * Tenant Backup at /settings/backups).
 *
 * Phase 1 ships the Secrets Bundle tab only. Phases 2-5 add System
 * Databases, Stalwart BLOB, Longhorn Snapshots, WAL Archive and DR
 * Drill tabs (placeholders not rendered until those phases land).
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, AlertTriangle } from 'lucide-react';
import SecretsBundleTab from '@/components/system-backup/SecretsBundleTab';
import SystemDatabasesTab from '@/components/system-backup/SystemDatabasesTab';
import WalArchiveTab from '@/components/system-backup/WalArchiveTab';
import LonghornSnapshotsTab from '@/components/system-backup/LonghornSnapshotsTab';

type TabId = 'secrets' | 'system-dbs' | 'stalwart-blob' | 'longhorn-snapshots' | 'wal-archive' | 'dr-drill';

interface TabSpec {
  id: TabId;
  label: string;
  available: boolean;
  comingPhase?: string;
}

const TABS: ReadonlyArray<TabSpec> = [
  { id: 'secrets', label: 'Secrets Bundle', available: true },
  { id: 'system-dbs', label: 'System Databases', available: true },
  { id: 'stalwart-blob', label: 'Stalwart BLOB', available: false, comingPhase: 'Phase 2' },
  { id: 'longhorn-snapshots', label: 'Longhorn Snapshots', available: true },
  { id: 'wal-archive', label: 'WAL Archive', available: true },
  { id: 'dr-drill', label: 'DR Drill', available: false, comingPhase: 'Phase 5' },
];

export default function SystemBackupPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = (searchParams.get('tab') ?? 'secrets') as TabId;
  const initial: TabId = TABS.find((t) => t.id === tabFromUrl)?.available ? tabFromUrl : 'secrets';
  const [activeTab, setActiveTab] = useState<TabId>(initial);

  const onSelect = (id: TabId, available: boolean) => {
    if (!available) return;
    setActiveTab(id);
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <Shield size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">System Backup</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
          Cluster-state recovery: secrets, system databases, Stalwart mail BLOB,
          Longhorn snapshots, optional WAL streaming and DR drill. Customer and
          tenant data is managed separately under{' '}
          <a href="/settings/backups" className="text-brand-600 dark:text-brand-400 hover:underline">
            Tenant Backup
          </a>.
        </p>
      </header>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-1 -mb-px overflow-x-auto" data-testid="system-backup-tabs">
          {TABS.map((t) => {
            const isActive = activeTab === t.id;
            const cls = [
              'px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
              isActive
                ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                : t.available
                  ? 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-600'
                  : 'border-transparent text-gray-400 dark:text-gray-600 cursor-not-allowed',
            ].join(' ');
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id, t.available)}
                disabled={!t.available}
                className={cls}
                data-testid={`system-backup-tab-${t.id}`}
              >
                {t.label}
                {!t.available && t.comingPhase && (
                  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">({t.comingPhase})</span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div>
        {activeTab === 'secrets' && <SecretsBundleTab />}
        {activeTab === 'system-dbs' && <SystemDatabasesTab />}
        {activeTab === 'wal-archive' && <WalArchiveTab />}
        {activeTab === 'longhorn-snapshots' && <LonghornSnapshotsTab />}
        {activeTab !== 'secrets' && activeTab !== 'system-dbs' && activeTab !== 'wal-archive' && activeTab !== 'longhorn-snapshots' && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-8 text-center">
            <AlertTriangle size={32} className="mx-auto text-gray-400 dark:text-gray-500 mb-3" />
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {TABS.find((t) => t.id === activeTab)?.label} ships in {TABS.find((t) => t.id === activeTab)?.comingPhase}.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
