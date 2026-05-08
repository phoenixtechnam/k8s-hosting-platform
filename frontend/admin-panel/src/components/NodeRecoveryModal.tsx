import { useState } from 'react';
import { Loader2, AlertTriangle, X } from 'lucide-react';
import {
  useCleanStalePods,
  useRecyclePod,
  useRestartCsiPlugin,
  type NodeHealthEntry,
} from '@/hooks/use-node-health';

type ActionKind =
  | 'clean-stale-pods'
  | 'restart-csi-plugin'
  | 'recycle-pod';

interface ActionDef {
  readonly kind: ActionKind;
  readonly label: string;
  readonly description: string;
  /** True when the entry's symptoms match this action — controls
   *  whether the action shows up by default. Operator can still
   *  pick any action via "show all". */
  readonly suggestedWhen: (entry: NodeHealthEntry) => boolean;
}

const ACTIONS: ReadonlyArray<ActionDef> = [
  {
    kind: 'clean-stale-pods',
    label: 'Clean stale pod records on this node',
    description:
      'Bulk-deletes Failed/Evicted/ContainerStatusUnknown pods on this node. Refuses tenant + CNPG instance pods. Zero risk — they are already dead K8s records.',
    suggestedWhen: (e) => e.evictionsLastHour > 0 || e.pressures.includes('disk') || e.pressures.includes('memory'),
  },
  {
    kind: 'restart-csi-plugin',
    label: 'Restart Longhorn CSI plugin on this node',
    description:
      'Deletes the longhorn-csi-plugin pod; DaemonSet replaces it; new pod re-registers driver.longhorn.io with the kubelet. Use when a baseline CSI driver is missing.',
    suggestedWhen: (e) => e.csiDriversMissing.includes('driver.longhorn.io'),
  },
  {
    kind: 'recycle-pod',
    label: 'Recycle a specific system pod',
    description:
      'Deletes the chosen pod (controller reschedules, containerd GCs the writable layer). Use when a single pod has runaway storage growth — fixed the 2026-05-08 worker calico-node 28GB core-dump bleed.',
    suggestedWhen: (e) => e.pressures.includes('disk'),
  },
];

interface Props {
  readonly entry: NodeHealthEntry;
  readonly onClose: () => void;
}

export default function NodeRecoveryModal({ entry, onClose }: Props) {
  const suggested = ACTIONS.filter((a) => a.suggestedWhen(entry));
  const initialKind = suggested[0]?.kind ?? 'clean-stale-pods';
  const [kind, setKind] = useState<ActionKind>(initialKind);
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  // recycle-pod inputs
  const [recycleNamespace, setRecycleNamespace] = useState('calico-system');
  const [recyclePodName, setRecyclePodName] = useState('');

  const cleanStale = useCleanStalePods();
  const restartCsi = useRestartCsiPlugin();
  const recycle = useRecyclePod();

  const isPending = cleanStale.isPending || restartCsi.isPending || recycle.isPending;
  const lastError = cleanStale.error ?? restartCsi.error ?? recycle.error;
  const lastSuccess = cleanStale.data ?? restartCsi.data ?? recycle.data;

  const confirmOk = confirmName.trim() === entry.name;
  const reasonOk = reason.trim().length >= 3;
  const recycleArgsOk =
    kind !== 'recycle-pod' || (recycleNamespace.trim() && recyclePodName.trim());
  const canSubmit = confirmOk && reasonOk && recycleArgsOk && !isPending;

  const submit = async () => {
    if (kind === 'clean-stale-pods') {
      await cleanStale.mutateAsync({ node: entry.name, reason: reason.trim() });
    } else if (kind === 'restart-csi-plugin') {
      await restartCsi.mutateAsync({ node: entry.name, reason: reason.trim() });
    } else {
      await recycle.mutateAsync({
        node: entry.name,
        namespace: recycleNamespace.trim(),
        podName: recyclePodName.trim(),
        reason: reason.trim(),
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Recover node: <span className="font-mono">{entry.name}</span>
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              severity: <span className={
                entry.severity === 'critical' ? 'font-medium text-red-600 dark:text-red-400'
                : entry.severity === 'warning' ? 'font-medium text-amber-600 dark:text-amber-400'
                : 'text-green-600 dark:text-green-400'
              }>{entry.severity}</span>
              {entry.pressures.length > 0 && <> · pressures: {entry.pressures.join(', ')}</>}
              {entry.csiDriversMissing.length > 0 && <> · CSI missing: {entry.csiDriversMissing.join(', ')}</>}
              {entry.evictionsLastHour > 0 && <> · {entry.evictionsLastHour} evictions/h</>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-2 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Action
            </label>
            <div className="space-y-2">
              {ACTIONS.map((a) => {
                const isSuggested = suggested.some((s) => s.kind === a.kind);
                return (
                  <label
                    key={a.kind}
                    className={
                      `flex cursor-pointer items-start gap-2 rounded border p-3 text-sm
                       ${kind === a.kind
                         ? 'border-brand-500 bg-brand-50/40 dark:border-brand-400 dark:bg-brand-900/20'
                         : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40'}`
                    }
                  >
                    <input
                      type="radio"
                      name="recovery-action"
                      value={a.kind}
                      checked={kind === a.kind}
                      onChange={() => setKind(a.kind)}
                      className="mt-0.5"
                      data-testid={`recovery-action-${a.kind}`}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{a.label}</span>
                        {isSuggested && (
                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                            suggested
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{a.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {kind === 'recycle-pod' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Namespace</label>
                <input
                  value={recycleNamespace}
                  onChange={(e) => setRecycleNamespace(e.target.value)}
                  placeholder="e.g. calico-system"
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Pod name</label>
                <input
                  value={recyclePodName}
                  onChange={(e) => setRecyclePodName(e.target.value)}
                  placeholder="e.g. calico-node-m6lzr"
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div className="col-span-2 rounded border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-400">
                Allowed: calico-system · longhorn-system · ingress-nginx · kube-system · cnpg-system (operator only) · cert-manager · flux-system · platform-system · tigera-operator. Tenant + CNPG instance pods are refused.
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Reason (≥3 chars, audit-logged)
            </label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. DiskPressure recovery — calico-node core-dump bleed"
              className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Confirm: type the node name <span className="font-mono">{entry.name}</span>
            </label>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={entry.name}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              data-testid="recovery-confirm-name"
            />
          </div>

          {lastError && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Action failed</div>
                  <div className="mt-0.5 break-words">{(lastError as Error).message}</div>
                </div>
              </div>
            </div>
          )}

          {lastSuccess && (
            <div className="rounded border border-green-200 bg-green-50 p-3 text-xs text-green-800 dark:border-green-900/40 dark:bg-green-900/20 dark:text-green-300">
              <div className="font-medium">Action complete</div>
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10px]">
                {JSON.stringify((lastSuccess as { data: unknown }).data, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
            data-testid="recovery-submit"
          >
            {isPending && <Loader2 className="animate-spin" size={14} />}
            Run action
          </button>
        </div>
      </div>
    </div>
  );
}
