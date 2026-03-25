import { Globe, Database, Archive, Mail } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';

const quickStats = [
  { label: 'Domains', value: '--', icon: Globe, color: 'bg-blue-50 text-blue-600' },
  { label: 'Databases', value: '--', icon: Database, color: 'bg-green-50 text-green-600' },
  { label: 'Backups', value: '--', icon: Archive, color: 'bg-amber-50 text-amber-600' },
  { label: 'Email Accounts', value: '--', icon: Mail, color: 'bg-purple-50 text-purple-600' },
] as const;

export default function Dashboard() {
  const { user } = useAuth();
  const displayName = user?.fullName ?? user?.email ?? 'there';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900" data-testid="welcome-heading">
          Welcome back, {displayName}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Here is an overview of your hosting account.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="quick-stats">
        {quickStats.map(({ label, value, icon: Icon, color }) => (
          <div
            key={label}
            className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>
                <Icon size={20} />
              </div>
              <div>
                <p className="text-sm text-gray-500">{label}</p>
                <p className="text-xl font-semibold text-gray-900">{value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Getting Started</h2>
        <p className="mt-2 text-sm text-gray-500">
          Use the sidebar navigation to manage your domains, databases, files, email accounts, and backups.
          More features will be available soon.
        </p>
      </div>
    </div>
  );
}
