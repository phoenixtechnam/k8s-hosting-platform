/**
 * Longhorn Snapshots tab on /system-backup. Reuses the same
 * SystemSnapshotsSection component the Storage page renders so both
 * surfaces stay in sync without duplicate logic.
 */
import { Camera } from 'lucide-react';
import SystemSnapshotsSection from '@/components/SystemSnapshotsSection';

export default function LonghornSnapshotsTab() {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <Camera size={20} /> Longhorn Snapshots
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          On-cluster Longhorn volume snapshots for system PVCs (platform DB,
          mail DB, file-manager state). Snapshots are managed by Longhorn's
          RecurringJob policies; click into a workload to inspect, prune, or
          promote individual snapshots.
        </p>
      </header>
      <SystemSnapshotsSection />
    </div>
  );
}
