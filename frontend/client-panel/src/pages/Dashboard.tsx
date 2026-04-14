import { Link } from 'react-router-dom';
import {
  Globe, AppWindow, Archive, Server, Mail, CreditCard,
  Cpu, HardDrive, MemoryStick, Bell, ArrowRight, CheckCircle2,
  AlertCircle, Info, AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '@/hooks/use-auth';
import { useClientContext } from '@/hooks/use-client-context';
import { useDomains } from '@/hooks/use-domains';
import { useBackups } from '@/hooks/use-backups';
import { useDeployments, useResourceUsage } from '@/hooks/use-deployments';
import { useMailboxUsage } from '@/hooks/use-email';
import { useCatalog } from '@/hooks/use-catalog';
import { useSubscription } from '@/hooks/use-subscription';
import { useNotifications } from '@/hooks/use-notifications';

function parseResourceValue(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.endsWith('Gi')) return parseFloat(trimmed) * 1024;
  if (trimmed.endsWith('Mi')) return parseFloat(trimmed);
  if (trimmed.endsWith('m')) return parseFloat(trimmed) / 1000;
  return parseFloat(trimmed) || 0;
}

function formatPercent(used: string, limit: string): number {
  const u = parseResourceValue(used);
  const l = parseResourceValue(limit);
  if (l <= 0) return 0;
  return Math.min(Math.round((u / l) * 100), 100);
}

export default function Dashboard() {
  const { user } = useAuth();
  const { clientId } = useClientContext();
  const displayName = user?.fullName ?? user?.email ?? 'there';

  const { data: domainsData } = useDomains(clientId ?? undefined);
  const { data: backupsData } = useBackups(clientId ?? undefined);
  const { data: deploymentsData } = useDeployments(clientId ?? undefined);
  const { data: mailboxUsageData, isLoading: mailboxUsageLoading } = useMailboxUsage(
    clientId ?? undefined,
  );
  const { data: catalogData } = useCatalog();
  const { data: subscriptionData } = useSubscription(clientId ?? undefined);
  const { data: resourceUsageData } = useResourceUsage(clientId ?? undefined);
  const { data: notificationsData } = useNotifications(5);

  const domainCount = domainsData?.data?.length ?? 0;
  const backupCount = backupsData?.data?.length ?? 0;
  const deploymentCount = deploymentsData?.data?.length ?? 0;
  const mailboxUsage = mailboxUsageData?.data;
  const mailboxStat: number | string = mailboxUsageLoading || !mailboxUsage
    ? '\u2014'
    : `${mailboxUsage.current}/${mailboxUsage.limit}`;

  const stats = [
    { label: 'Domains', value: domainCount, icon: Globe, color: 'bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
    { label: 'Applications', value: deploymentCount, icon: AppWindow, color: 'bg-green-50 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
    { label: 'Backups', value: backupCount, icon: Archive, color: 'bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400' },
    { label: 'Deployments', value: deploymentCount, icon: Server, color: 'bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400' },
    { label: 'Email accounts', value: mailboxStat, icon: Mail, color: 'bg-rose-50 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400' },
  ];

  // Catalog map for deployment -> catalog entry name lookup
  const catalogEntries = catalogData?.data ?? [];
  const catalogMap = new Map(catalogEntries.map((e) => [e.id, e]));

  // Active deployments (non-deleted), top 5
  const activeDeployments = (deploymentsData?.data ?? [])
    .filter((d) => !d.deletedAt)
    .slice(0, 5);

  // Subscription
  const subscription = subscriptionData?.data ?? null;
  const plan = subscription?.plan ?? null;

  // Resource usage
  const resources = resourceUsageData?.data ?? null;

  // Notifications (top 3)
  const notifications = (notificationsData?.data ?? []).slice(0, 3);

  const notificationIcon = (type: string) => {
    switch (type) {
      case 'success': return <CheckCircle2 size={14} className="text-green-500 dark:text-green-400 shrink-0" />;
      case 'error': return <AlertCircle size={14} className="text-red-500 dark:text-red-400 shrink-0" />;
      case 'warning': return <AlertTriangle size={14} className="text-amber-500 dark:text-amber-400 shrink-0" />;
      default: return <Info size={14} className="text-blue-500 dark:text-blue-400 shrink-0" />;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300';
      case 'stopped': return 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300';
      case 'deploying':
      case 'pending':
      case 'upgrading': return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300';
      case 'error':
      case 'failed': return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300';
      default: return 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="welcome-heading">
          Welcome back, {displayName}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Here is an overview of your hosting account.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="quick-stats">
        {stats.map(({ label, value, icon: Icon, color }) => (
          <div
            key={label}
            className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>
                <Icon size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
                <p className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid={`stat-${label.toLowerCase()}`}>{value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Two-column grid for detail sections */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Subscription Details */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="subscription-card">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
            <div className="flex items-center gap-2">
              <CreditCard size={16} className="text-indigo-500 dark:text-indigo-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Subscription</h2>
            </div>
            <Link
              to="/settings"
              className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300"
            >
              Manage
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Plan</span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {plan?.name ?? 'Your Plan'}
              </span>
            </div>
            {plan?.description && (
              <p className="text-xs text-gray-400 dark:text-gray-500">{plan.description}</p>
            )}
            {subscription?.subscription_expires_at && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500 dark:text-gray-400">Expires</span>
                <span className="text-sm text-gray-900 dark:text-gray-100">
                  {new Date(subscription.subscription_expires_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                </span>
              </div>
            )}
            {plan && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">CPU limit</span>
                  <span className="text-sm text-gray-900 dark:text-gray-100">{plan.cpuLimit}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Memory limit</span>
                  <span className="text-sm text-gray-900 dark:text-gray-100">{plan.memoryLimit}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Storage limit</span>
                  <span className="text-sm text-gray-900 dark:text-gray-100">{plan.storageLimit}</span>
                </div>
              </>
            )}
            {subscription?.status && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500 dark:text-gray-400">Status</span>
                <span className={clsx(
                  'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                  subscription.status === 'active' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300',
                )}>
                  {subscription.status}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Deployed Applications */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="deployments-card">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
            <div className="flex items-center gap-2">
              <AppWindow size={16} className="text-green-500 dark:text-green-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Deployed Applications</h2>
            </div>
            <Link
              to="/applications"
              className="inline-flex items-center gap-1 text-sm font-medium text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300"
            >
              View All
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="px-5 py-4">
            {activeDeployments.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No active deployments yet.</p>
            ) : (
              <div className="space-y-3">
                {activeDeployments.map((d) => {
                  const entry = catalogMap.get(d.catalogEntryId);
                  return (
                    <div key={d.id} className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{d.name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                          {entry?.name ?? 'Unknown entry'}
                        </p>
                      </div>
                      <span className={clsx(
                        'ml-3 inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                        statusColor(d.status),
                      )}>
                        {d.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Resource Usage */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="resource-usage-card">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
            <div className="flex items-center gap-2">
              <Cpu size={16} className="text-purple-500 dark:text-purple-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Resource Usage</h2>
            </div>
            <Link
              to="/resource-usage"
              className="inline-flex items-center gap-1 text-sm font-medium text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300"
            >
              Details
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="px-5 py-4 space-y-4">
            {resources ? (
              <>
                <ResourceBar
                  label="CPU"
                  icon={<Cpu size={14} className="text-blue-500 dark:text-blue-400" />}
                  used={resources.cpu.used}
                  limit={resources.cpu.limit}
                  percent={formatPercent(resources.cpu.used, resources.cpu.limit)}
                  barColor="bg-blue-500 dark:bg-blue-400"
                />
                <ResourceBar
                  label="Memory"
                  icon={<MemoryStick size={14} className="text-emerald-500 dark:text-emerald-400" />}
                  used={resources.memory.used}
                  limit={resources.memory.limit}
                  percent={formatPercent(resources.memory.used, resources.memory.limit)}
                  barColor="bg-emerald-500 dark:bg-emerald-400"
                />
                <ResourceBar
                  label="Storage"
                  icon={<HardDrive size={14} className="text-amber-500 dark:text-amber-400" />}
                  used={resources.storage.used}
                  limit={resources.storage.limit}
                  percent={formatPercent(resources.storage.used, resources.storage.limit)}
                  barColor="bg-amber-500 dark:bg-amber-400"
                />
              </>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading resource data...</p>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="notifications-card">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
            <div className="flex items-center gap-2">
              <Bell size={16} className="text-rose-500 dark:text-rose-400" />
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Notifications</h2>
            </div>
            <Link
              to="/notifications"
              className="inline-flex items-center gap-1 text-sm font-medium text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300"
            >
              View All
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="px-5 py-4">
            {notifications.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No recent notifications.</p>
            ) : (
              <div className="space-y-3">
                {notifications.map((n) => (
                  <div key={n.id} className="flex items-start gap-2">
                    {notificationIcon(n.type)}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{n.title}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{n.message}</p>
                      <p className="mt-0.5 text-xs text-gray-300 dark:text-gray-600">
                        {new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    {n.isRead === 0 && (
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-500 dark:bg-blue-400" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Resource Bar ──────────────────────────────────────────────────────────

function ResourceBar({ label, icon, used, limit, percent, barColor }: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly used: string;
  readonly limit: string;
  readonly percent: number;
  readonly barColor: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
        <div
          className={clsx('h-2 rounded-full transition-all', barColor)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-0.5 text-right text-xs text-gray-400 dark:text-gray-500">{percent}%</p>
    </div>
  );
}
