import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import type { BackupHealthSummary } from '@k8s-hosting/api-contracts';

interface BackupHealthTableProps {
  readonly summaries: ReadonlyArray<BackupHealthSummary> | undefined;
  readonly isLoading?: boolean;
}

function badgeStatus(state: BackupHealthSummary['state']): 'healthy' | 'failed' | 'pending' {
  switch (state) {
    case 'healthy':
      return 'healthy';
    case 'failing':
      return 'failed';
    case 'never_run':
      return 'pending';
  }
}

function badgeLabel(state: BackupHealthSummary['state']): string {
  switch (state) {
    case 'healthy':
      return 'Healthy';
    case 'failing':
      return 'Failing';
    case 'never_run':
      return 'Never run';
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const CATEGORY_ORDER: ReadonlyArray<BackupHealthSummary['category']> = [
  'dr',
  'audit',
  'tenant',
  'custom',
];

const CATEGORY_LABEL: Record<BackupHealthSummary['category'], string> = {
  dr: 'Disaster Recovery',
  audit: 'Audit',
  tenant: 'Tenant Backups',
  custom: 'Custom',
};

export default function BackupHealthTable({ summaries, isLoading }: BackupHealthTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (isLoading && !summaries) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400" data-testid="backup-health-table-loading">
        Loading backup health…
      </div>
    );
  }

  const byCategory = new Map<BackupHealthSummary['category'], BackupHealthSummary[]>();
  for (const s of summaries ?? []) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push(s);
    byCategory.set(s.category, arr);
  }

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-6" data-testid="backup-health-table">
      {CATEGORY_ORDER.map((cat) => {
        const rows = byCategory.get(cat) ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={cat}>
            <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
              {CATEGORY_LABEL[cat]}
            </h3>
            <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/40">
                  <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
                    <th className="px-3 py-2 w-8" />
                    <th className="px-3 py-2">Backup</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Last success</th>
                    <th className="px-3 py-2">Last failure</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {rows.map((row) => {
                    const key = `${row.namespace}/${row.groupKey}`;
                    const isOpen = expanded.has(key);
                    const canExpand = Boolean(row.lastFailedReason);
                    return (
                      <Fragment key={key}>
                        <tr
                          className={canExpand ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40' : ''}
                          onClick={canExpand ? () => toggle(key) : undefined}
                          onKeyDown={
                            canExpand
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggle(key);
                                  }
                                }
                              : undefined
                          }
                          tabIndex={canExpand ? 0 : undefined}
                          role={canExpand ? 'button' : undefined}
                          aria-expanded={canExpand ? isOpen : undefined}
                        >
                          <td className="px-3 py-2 align-top">
                            {canExpand ? (
                              isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                            ) : null}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-gray-900 dark:text-gray-100">
                              {row.displayName}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {row.namespace}/{row.groupKey}
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <StatusBadge status={badgeStatus(row.state)} label={badgeLabel(row.state)} />
                          </td>
                          <td className="px-3 py-2 align-top text-gray-700 dark:text-gray-300">
                            {formatRelative(row.lastSuccessAt)}
                          </td>
                          <td className="px-3 py-2 align-top text-gray-700 dark:text-gray-300">
                            {formatRelative(row.lastFailedAt)}
                          </td>
                        </tr>
                        {isOpen && row.lastFailedReason && (
                          <tr className="bg-gray-50 dark:bg-gray-800/40">
                            <td />
                            <td colSpan={4} className="px-3 py-2">
                              <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                                Last failure reason
                              </div>
                              <pre className="whitespace-pre-wrap break-words text-xs text-gray-800 dark:text-gray-200">
                                {row.lastFailedReason}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {(summaries?.length ?? 0) === 0 && !isLoading && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No backup jobs are participating in health observability yet.
          Add the platform.phoenix-host.net/backup-health-watch=true label
          to a CronJob to opt in.
        </p>
      )}
    </div>
  );
}
