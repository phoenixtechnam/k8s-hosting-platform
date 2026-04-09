import { Globe, AppWindow, Archive, Server, Mail } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useClientContext } from '@/hooks/use-client-context';
import { useDomains } from '@/hooks/use-domains';
import { useBackups } from '@/hooks/use-backups';
import { useDeployments } from '@/hooks/use-deployments';
import { useMailboxUsage } from '@/hooks/use-email';

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

  const domainCount = domainsData?.data?.length ?? 0;
  const backupCount = backupsData?.data?.length ?? 0;
  const deploymentCount = deploymentsData?.data?.length ?? 0;
  const mailboxUsage = mailboxUsageData?.data;
  // Render "—" while loading (rather than flashing 0/0) so operators see a
  // clear "not ready yet" state. Once loaded, show "current/limit".
  const mailboxStat: number | string = mailboxUsageLoading || !mailboxUsage
    ? '—'
    : `${mailboxUsage.current}/${mailboxUsage.limit}`;

  const stats = [
    { label: 'Domains', value: domainCount, icon: Globe, color: 'bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400' },
    { label: 'Applications', value: deploymentCount, icon: AppWindow, color: 'bg-green-50 text-green-600 dark:bg-green-900/40 dark:text-green-400' },
    { label: 'Backups', value: backupCount, icon: Archive, color: 'bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400' },
    { label: 'Deployments', value: deploymentCount, icon: Server, color: 'bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400' },
    { label: 'Email accounts', value: mailboxStat, icon: Mail, color: 'bg-rose-50 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400' },
  ];

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

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Getting Started</h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Use the sidebar navigation to manage your domains, applications, workloads, cron jobs, and backups.
        </p>
      </div>
    </div>
  );
}
