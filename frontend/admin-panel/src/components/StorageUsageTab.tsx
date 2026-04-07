import { useState } from 'react';
import { HardDrive, Loader2, Trash2, AlertTriangle, CheckCircle } from 'lucide-react';
import clsx from 'clsx';
import { useStorageOverview, useImageInventory, usePurgeImages } from '@/hooks/use-storage';
import type { ImageEntry } from '@k8s-hosting/api-contracts';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function StorageUsageTab() {
  const { data: overviewData, isLoading: overviewLoading } = useStorageOverview();
  const { data: inventoryData, isLoading: inventoryLoading } = useImageInventory();
  const purgeMutation = usePurgeImages();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'in-use' | 'purgeable'>('all');

  const overview = overviewData?.data;
  const inventory = inventoryData?.data;
  const images: readonly ImageEntry[] = inventory?.images ?? [];

  const filteredImages = images.filter(img => {
    if (filter === 'in-use') return img.inUse;
    if (filter === 'purgeable') return !img.protected && !img.inUse;
    return true;
  }).sort((a, b) => b.sizeBytes - a.sizeBytes);

  const handlePreviewPurge = () => {
    purgeMutation.mutate({ dryRun: true }, {
      onSuccess: () => setConfirmOpen(true),
    });
  };

  const handleConfirmPurge = () => {
    purgeMutation.mutate({ dryRun: false }, {
      onSuccess: () => {
        setTimeout(() => setConfirmOpen(false), 3000);
      },
    });
  };

  if (overviewLoading || inventoryLoading) {
    return (
      <div className="flex items-center justify-center p-10 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" /> Loading storage data...
      </div>
    );
  }

  return (
    <div className="p-5 space-y-6" data-testid="storage-usage-tab">
      {/* System Usage Summary */}
      {overview && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Platform DB" value={formatBytes(overview.system.platformDatabase.usedBytes)} />
          <StatTile label="Redis" value={formatBytes(overview.system.redis.usedBytes)} />
          <StatTile
            label="Docker Images"
            value={formatBytes(overview.system.dockerImages.totalBytes)}
            sublabel={`${overview.system.dockerImages.count} images`}
          />
          <StatTile label="Total Client Data" value={formatBytes(overview.total.clientBytes)} />
        </div>
      )}

      {/* Per-Client Usage Table */}
      {overview && overview.clients.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <HardDrive size={16} className="text-blue-600 dark:text-blue-400" />
              Per-Client Storage Usage
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                <th className="px-5 py-2">Client</th>
                <th className="px-5 py-2">Namespace</th>
                <th className="px-5 py-2 text-right">Used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {[...overview.clients].sort((a, b) => b.usedBytes - a.usedBytes).map(client => (
                <tr key={client.clientId} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-5 py-2.5 font-medium text-gray-900 dark:text-gray-100">{client.companyName}</td>
                  <td className="px-5 py-2.5 font-mono text-xs text-gray-500 dark:text-gray-400">{client.namespace}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-gray-700 dark:text-gray-300">{formatBytes(client.usedBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Docker Image Inventory */}
      {inventory && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Docker Image Inventory
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                ({inventory.images.length} images, {formatBytes(inventory.totalBytes)} total)
              </span>
            </h3>
            <div className="flex items-center gap-2">
              {(['all', 'in-use', 'purgeable'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={clsx(
                    'px-3 py-1 text-xs rounded-md border transition-colors',
                    filter === f
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50',
                  )}
                  data-testid={`filter-${f}`}
                >
                  {f}
                </button>
              ))}
              <button
                type="button"
                onClick={handlePreviewPurge}
                disabled={purgeMutation.isPending || inventory.purgeableCount === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="purge-preview-button"
              >
                {purgeMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Purge Cache ({formatBytes(inventory.purgeableBytes)})
              </button>
            </div>
          </div>
          <div className="max-h-[500px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                  <th className="px-5 py-2">Image</th>
                  <th className="px-5 py-2 text-center">Status</th>
                  <th className="px-5 py-2 text-right">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {filteredImages.map(img => (
                  <tr key={img.name} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-5 py-2 font-mono text-xs text-gray-700 dark:text-gray-300 truncate max-w-lg">{img.name}</td>
                    <td className="px-5 py-2 text-center">
                      {img.protected ? (
                        <span className="inline-flex rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">protected</span>
                      ) : img.inUse ? (
                        <span className="inline-flex rounded-full bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">in use</span>
                      ) : (
                        <span className="inline-flex rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">purgeable</span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-xs text-gray-600 dark:text-gray-400">{formatBytes(img.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Confirm Purge Modal */}
      {confirmOpen && purgeMutation.data?.data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center gap-2">
              {purgeMutation.data.data.dryRun ? (
                <>
                  <AlertTriangle size={20} className="text-amber-500" />
                  Confirm Image Purge
                </>
              ) : (
                <>
                  <CheckCircle size={20} className="text-green-500" />
                  Purge Complete
                </>
              )}
            </h3>
            {purgeMutation.data.data.dryRun ? (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                  This will remove {purgeMutation.data.data.removedImages.length} unused images, freeing <strong>{formatBytes(purgeMutation.data.data.freedBytes)}</strong>. Protected and in-use images will NOT be touched.
                </p>
                <div className="max-h-48 overflow-y-auto rounded-lg bg-gray-50 dark:bg-gray-900 p-3 mb-4">
                  {purgeMutation.data.data.removedImages.length === 0 ? (
                    <p className="text-xs text-gray-500 dark:text-gray-400">No images to purge.</p>
                  ) : (
                    <ul className="text-xs font-mono text-gray-700 dark:text-gray-300 space-y-1">
                      {purgeMutation.data.data.removedImages.map(name => <li key={name}>{name}</li>)}
                    </ul>
                  )}
                </div>
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(false)}
                    className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmPurge}
                    disabled={purgeMutation.isPending || purgeMutation.data.data.removedImages.length === 0}
                    className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
                    data-testid="purge-confirm-button"
                  >
                    {purgeMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    Confirm Purge
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                  Removed {purgeMutation.data.data.removedImages.length} images. Freed <strong>{formatBytes(purgeMutation.data.data.freedBytes)}</strong>.
                </p>
                {purgeMutation.data.data.errors.length > 0 && (
                  <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 mb-4">
                    <p className="text-xs font-semibold text-red-700 dark:text-red-300 mb-1">Errors:</p>
                    <ul className="text-xs text-red-600 dark:text-red-400 space-y-1">
                      {purgeMutation.data.data.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="w-full px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, sublabel }: { readonly label: string; readonly value: string; readonly sublabel?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sublabel && <p className="text-xs text-gray-400 dark:text-gray-500">{sublabel}</p>}
    </div>
  );
}
