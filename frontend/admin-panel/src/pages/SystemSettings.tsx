import { SettingsIcon } from 'lucide-react';
import SystemSettingsForm from '@/components/SystemSettings';

export default function SystemSettings() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700 dark:text-gray-300" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="system-settings-heading">
            System Settings
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Configure platform identity, networking, mail, and rate limits.
          </p>
        </div>
      </div>
      <SystemSettingsForm />
    </div>
  );
}
