import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Database, Cloud, ExternalLink, Zap, X, AlertTriangle, RefreshCw, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import { usePlatformUrls, resolveLonghornUrl } from '@/hooks/use-platform-urls';
import StorageInventoryCard from '@/components/StorageInventoryCard';
import PlatformStoragePolicyCard from '@/components/PlatformStoragePolicyCard';
import { useSweepNamespaceIntegrity } from '@/hooks/use-namespace-integrity';

/**
 * Storage Configuration
 *
 * Landing page for storage-related admin tasks. Shows:
 *   - Active backup target summary (or "none configured" CTA)
 *   - Link to full backup-target CRUD (BackupSettings)
 *   - "Open Longhorn" button → modal iframe. Gated at the Longhorn
 *     ingress by admin-auth-gate-cookie, so only admins get through.
 *
 * Storage inventory (node health, volume count, capacity) will live
 * here too once Phase D's /admin/platform/storage endpoint lands.
 */
interface StorageSettingsProps {
  /** When true, omit the page-level <h1> header so the panel can be embedded inside a tabbed layout (e.g. NodesAndStorage). */
  readonly embedded?: boolean;
}

export default function StorageSettings({ embedded = false }: StorageSettingsProps = {}) {
  const [showIframe, setShowIframe] = useState(false);
  const { data: configsResp, isLoading } = useBackupConfigs();
  const { data: urls } = usePlatformUrls();

  const configs = configsResp?.data ?? [];
  const activeConfig = configs.find((c) => c.active);
  // Prefer the DB-resolved URL; fall back to the ConfigMap-derived
  // value during the window between first paint and the query resolving.
  const longhornUrl = resolveLonghornUrl(urls);

  return (
    <div className="space-y-6">
      {!embedded && (
        <div className="flex items-center gap-3">
          <HardDrive size={28} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="storage-settings-heading">
            Storage Configuration
          </h1>
        </div>
      )}

      {/* ─── Live inventory ─── */}
      <StorageInventoryCard />

      {/* ─── Platform-storage replication policy (M13) ─── */}
      <PlatformStoragePolicyCard />

      <NamespaceIntegrityCard />

      {/* ─── Longhorn dashboard ─── */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-3">
          <Database size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Longhorn Distributed Storage</h2>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-400">
          Longhorn provides the cluster's persistent volumes. The dashboard exposes
          volume health, snapshots, backups, and node capacity. Access is gated by
          the same admin session used for this panel — operators never see the
          Longhorn UI directly.
        </p>

        {longhornUrl ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowIframe(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
              data-testid="open-longhorn-button"
            >
              <ExternalLink size={14} /> Open Longhorn
            </button>
            <a
              href={longhornUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              data-testid="open-longhorn-newtab"
            >
              <ExternalLink size={14} /> Open in new tab
            </a>
          </div>
        ) : (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200"
            data-testid="longhorn-not-configured"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              Longhorn URL is not configured.{' '}
              <Link to="/settings/system" className="underline font-medium">
                Set it in System Settings →
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* ─── Active backup target summary ─── */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Cloud size={20} className="text-gray-700 dark:text-gray-300" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Active Backup Target</h2>
          </div>
          <Link
            to="/settings/backups"
            className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
            data-testid="manage-backup-targets-link"
          >
            Manage →
          </Link>
        </div>

        {isLoading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : activeConfig ? (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Name</dt>
              <dd className="mt-1 flex items-center gap-2 text-gray-900 dark:text-gray-100">
                {activeConfig.name}
                <span className="inline-flex items-center gap-1 rounded-md bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                  <Zap size={11} /> Active
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Provider</dt>
              <dd className="mt-1 text-gray-900 dark:text-gray-100">
                {activeConfig.storageType === 's3' ? 'S3-compatible' : 'SSH'}
              </dd>
            </div>
            {activeConfig.storageType === 's3' && (
              <>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Endpoint</dt>
                  <dd className="mt-1 font-mono text-xs text-gray-900 dark:text-gray-100 break-all">
                    {activeConfig.s3Endpoint}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">Bucket</dt>
                  <dd className="mt-1 font-mono text-xs text-gray-900 dark:text-gray-100">
                    {activeConfig.s3Bucket}
                    {activeConfig.s3Prefix ? `/${activeConfig.s3Prefix}` : ''}
                    {' @ '}
                    {activeConfig.s3Region}
                  </dd>
                </div>
              </>
            )}
            {activeConfig.lastTestedAt && (
              <div className="sm:col-span-2">
                <dt className="text-gray-500 dark:text-gray-400">Last tested</dt>
                <dd className="mt-1 text-gray-900 dark:text-gray-100">
                  {new Date(activeConfig.lastTestedAt).toLocaleString()} —{' '}
                  <span className={activeConfig.lastTestStatus === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                    {activeConfig.lastTestStatus}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <div className="rounded-lg bg-gray-50 dark:bg-gray-900/30 p-4 text-sm" data-testid="no-active-target">
            <p className="text-gray-700 dark:text-gray-300">
              No backup target is active. Longhorn volumes won't be backed up until one is configured.
            </p>
            <Link
              to="/settings/backups"
              className="mt-2 inline-flex items-center gap-1.5 text-brand-600 dark:text-brand-400 hover:underline"
            >
              Configure →
            </Link>
          </div>
        )}
      </div>

      {showIframe && longhornUrl && <LonghornIframeModal url={longhornUrl} onClose={() => setShowIframe(false)} />}
    </div>
  );
}

function LonghornIframeModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      data-testid="longhorn-iframe-modal"
      onClick={onClose}
    >
      {/* Centered bounded modal — matches the Stalwart web-admin iframe
          presentation so operators get a consistent admin-tool
          experience. Clicks on the backdrop close; clicks inside the
          panel (stopPropagation below) don't. */}
      <div
        className="relative w-full max-w-[1400px] h-[90vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2">
          <div className="flex items-center gap-2">
            <Database size={18} className="text-gray-700 dark:text-gray-300" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Longhorn Dashboard</span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-xs text-brand-600 dark:text-brand-400 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink size={12} /> open in new tab
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            data-testid="close-longhorn-iframe"
            aria-label="Close Longhorn"
          >
            <X size={18} />
          </button>
        </div>
        <iframe
          src={url}
          title="Longhorn Dashboard"
          className="flex-1 w-full border-0 bg-white"
          // Longhorn's SPA is served by its own ingress which was rendered
          // by the admin-auth-gate-cookie component — the platform_session
          // cookie travels along with the iframe request because its
          // Domain=.<apex> attribute includes the longhorn subdomain and
          // SameSite=None (set when SESSION_COOKIE_DOMAIN is configured).
        />
      </div>
    </div>
  );
}


/**
 * Issue 1 fix: surfaces the namespace-integrity reconciler. Auto-runs every
 * 30 min via the storage-lifecycle scheduler; this card lets an operator
 * trigger a fleet-wide sweep on demand. Per-client repair lives on the
 * Client Detail page banner.
 */
function NamespaceIntegrityCard() {
  const sweep = useSweepNamespaceIntegrity();
  const result = sweep.data?.data;
  const err = sweep.error as { message?: string } | null;
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-3">
        <RefreshCw size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Namespace integrity</h2>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        After a cluster rebootstrap or DR restore, a tenant namespace can lose its PVC,
        ResourceQuota, or NetworkPolicies while still appearing provisioned. The reconciler
        sweeps every provisioned client every 30 minutes and re-creates the missing pieces.
        Run it now from here when you suspect drift after an incident.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="namespace-integrity-sweep-button"
        >
          {sweep.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Run fleet sweep
        </button>
        {result && (
          <span className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <CheckCircle size={14} className="text-green-600 dark:text-green-400" />
            checked {result.checked} · repaired {result.repaired} · errored {result.errored}
          </span>
        )}
        {err && (
          <span className="inline-flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={14} />
            {err.message}
          </span>
        )}
      </div>
    </div>
  );
}
