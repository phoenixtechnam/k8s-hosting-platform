import { useState } from 'react';
import { HardDrive, Archive, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import StatCard from '@/components/ui/StatCard';
import ResourceBar from '@/components/ui/ResourceBar';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';
import { useBackups } from '@/hooks/use-backups';
import type { BackupResponse } from '@k8s-hosting/api-contracts';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

type Tab = 'overview' | 'backups';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'backups', label: 'Backups' },
] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}...` : id;
}

export default function Storage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const {
    data: backupsData,
    isLoading: backupsLoading,
    error: backupsError,
  } = useBackups(selectedClientId ?? undefined);

  const backups = backupsData?.data ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Storage &amp; Backups</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="Total Storage" value="1.2 TB" icon={HardDrive} accent="brand" />
        <StatCard title="Backups" value={backups.length} icon={Archive} accent="amber" />
        <StatCard
          title="Storage Used"
          value="31%"
          subtitle="of allocated capacity"
          icon={HardDrive}
          accent="brand"
        />
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-6" data-testid="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300',
              )}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'backups' && (
        <DataTab
          selectedClientId={selectedClientId}
          onClientChange={setSelectedClientId}
          isLoading={backupsLoading}
          error={backupsError}
        >
          <BackupsTable backups={backups} />
        </DataTab>
      )}
    </div>
  );
}

function OverviewTab() {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Storage Allocation</h2>
      <div className="space-y-5">
        <ResourceBar label="Block Storage" used={280} total={500} unit=" GB" />
        <ResourceBar label="Backup Storage" used={520} total={800} unit=" GB" />
      </div>
    </div>
  );
}

interface DataTabProps {
  readonly selectedClientId: string | null;
  readonly onClientChange: (id: string | null) => void;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly children: React.ReactNode;
}

function DataTab({ selectedClientId, onClientChange, isLoading, error, children }: DataTabProps) {
  return (
    <div className="space-y-4">
      <SearchableClientSelect
        selectedClientId={selectedClientId}
        onSelect={onClientChange}
        placeholder="Search clients..."
      />

      {!selectedClientId && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-16 text-center shadow-sm">
          <Archive size={40} className="mx-auto text-gray-300" />
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400" data-testid="select-client-prompt">
            Select a client to view their data.
          </p>
        </div>
      )}

      {selectedClientId && isLoading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      )}

      {selectedClientId && error && (
        <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="data-error">
          {error instanceof Error ? error.message : 'Failed to load data'}
        </div>
      )}

      {selectedClientId && !isLoading && !error && children}
    </div>
  );
}

interface BackupsTableProps {
  readonly backups: readonly BackupResponse[];
}

function BackupsTable({ backups }: BackupsTableProps) {
  const { sortedData: sortedBackups, sortKey, sortDirection, onSort } = useSortable(backups, 'createdAt', 'desc');

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full" data-testid="backups-table">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              <SortableHeader label="Backup ID" sortKey="id" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Type" sortKey="backupType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Resource" sortKey="resourceType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Size" sortKey="sizeBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
              <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
              <SortableHeader label="Expires" sortKey="expiresAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sortedBackups.map((backup) => (
              <tr key={backup.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-5 py-3.5">
                  <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{truncateId(backup.id)}</span>
                </td>
                <td className="px-5 py-3.5">
                  <span
                    className={clsx(
                      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
                      backup.backupType === 'auto'
                        ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300'
                        : 'bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-300',
                    )}
                  >
                    {backup.backupType}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{backup.resourceType}</td>
                <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell">
                  {backup.sizeBytes ? formatBytes(backup.sizeBytes) : '---'}
                </td>
                <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                  {new Date(backup.createdAt).toLocaleDateString()}
                </td>
                <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                  {backup.expiresAt ? new Date(backup.expiresAt).toLocaleDateString() : '---'}
                </td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                  No backups found for this client.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
