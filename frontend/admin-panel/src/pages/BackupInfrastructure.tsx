/**
 * Backup Infrastructure — consolidated Targets + Classes page.
 *
 * Replaces the standalone /settings/backups and /settings/backup-classes
 * pages with a 2-tab wrapper. The bodies of both pages still ship as
 * default-export components from their original modules (kept stable
 * so deep-link bookmarks survive via a URL-redirect, not a body
 * change).
 *
 * The tab state lives in the `?tab=` query param so reload + share
 * preserve the active view.
 */

import { useSearchParams, Link } from 'react-router-dom';
import { Database, GitBranch } from 'lucide-react';
import clsx from 'clsx';
import BackupSettings from './BackupSettings';
import SnapshotClassAssignments from './SnapshotClassAssignments';

type Tab = 'targets' | 'classes';

const TABS: Array<{ id: Tab; label: string; icon: typeof Database; description: string }> = [
  { id: 'targets', label: 'Backup Targets', icon: Database, description: 'Define S3 / SSH / CIFS storage destinations' },
  { id: 'classes', label: 'Backup Classes', icon: GitBranch, description: 'Route each backup class (tenant snapshot, tenant bundle, system, mail) to a target' },
];

function isTab(v: string | null): v is Tab {
  return v === 'targets' || v === 'classes';
}

export default function BackupInfrastructure() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = isTab(raw) ? raw : 'targets';

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Backup Infrastructure
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Configure where backups are stored and which class of data routes to which target.
        </p>
      </header>

      <nav className="border-b border-gray-200 dark:border-gray-700">
        <div className="-mb-px flex flex-wrap gap-x-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setParams({ tab: t.id }, { replace: true })}
                data-testid={`backup-infra-tab-${t.id}`}
                className={clsx(
                  'flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-brand-500 text-brand-600 dark:text-brand-300'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
                )}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        {TABS.find((t) => t.id === tab)?.description}
      </p>

      <div>
        {tab === 'targets' && <BackupSettings />}
        {tab === 'classes' && <SnapshotClassAssignments />}
      </div>

      <div className="text-xs text-gray-400 dark:text-gray-500">
        Tip: target rows show a "Used by classes" pill that links here.{' '}
        <Link to="/backups/system" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
          View System Backups →
        </Link>
        {' · '}
        <Link to="/backups/tenants" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
          View Tenant Backups →
        </Link>
      </div>
    </div>
  );
}
