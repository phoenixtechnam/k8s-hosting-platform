import { useState, type FormEvent } from 'react';
import { X, Save, Loader2, AlertCircle, CheckCircle, ShieldAlert } from 'lucide-react';
import { useUpdateClusterNode } from '@/hooks/use-cluster-nodes';
import type { ClusterNodeResponse, NodeIngressMode } from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const INGRESS_MODE_OPTIONS: ReadonlyArray<{ readonly value: NodeIngressMode; readonly label: string; readonly hint: string }> = [
  {
    value: 'all',
    label: 'ALL INGRESS',
    hint: 'nginx runs here, advertises this node\'s public IP, and can forward to any pod cluster-wide. Default for system servers.',
  },
  {
    value: 'local',
    label: 'LOCAL INGRESS',
    hint: 'nginx runs here but only forwards to pods scheduled on this same node. Cross-node traffic returns 503.',
  },
  {
    value: 'none',
    label: 'NO INGRESS',
    hint: 'No nginx pod here. Workloads still run, but public traffic is served via system servers.',
  },
];

interface NodeEditModalProps {
  readonly node: ClusterNodeResponse;
  readonly onClose: () => void;
}

/**
 * Modal-based edit dialog for a single cluster node.
 *
 * Replaces the inline NodeEditForm — the inline form crowded the row
 * and made it impossible to compare values across nodes while editing.
 * The modal also gates the destructive action (server→worker demotion)
 * behind an explicit `force` checkbox shown only when applicable.
 *
 * Fields:
 *  - displayName (alias) — operator-friendly label, falls back to k8s name.
 *  - role + canHostClientWorkloads — preserved from the legacy form.
 *  - ingressMode — three-state (all / local / none) — sets the
 *    platform.phoenix-host.net/ingress-mode label which the
 *    ingress-nginx DaemonSet's nodeAffinity respects.
 *  - notes — operator free text, surfaced only here.
 */
export default function NodeEditModal({ node, onClose }: NodeEditModalProps) {
  const update = useUpdateClusterNode(node.name);
  const [displayName, setDisplayName] = useState(node.displayName ?? '');
  const [role, setRole] = useState<'server' | 'worker'>(node.role);
  const [canHost, setCanHost] = useState(node.canHostClientWorkloads);
  const [ingressMode, setIngressMode] = useState<NodeIngressMode>(node.ingressMode);
  const [notes, setNotes] = useState(node.notes ?? '');
  const [force, setForce] = useState(false);

  const isDemotion = node.role === 'server' && role === 'worker';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        // Empty string clears the alias on the server.
        displayName: displayName.trim(),
        role,
        canHostClientWorkloads: canHost,
        ingressMode,
        notes: notes.trim() === '' ? null : notes,
        force: isDemotion && force ? true : undefined,
      });
      onClose();
    } catch {
      // error rendered below from update.error
    }
  };

  const err = update.error as { message?: string } | null;
  const isDemotionBlocked = Boolean(err?.message?.includes('NODE_DEMOTION_BLOCKED'));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-edit-modal-title"
      data-testid={`edit-node-${node.name}-modal`}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
        data-testid={`edit-node-${node.name}-form`}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 id="node-edit-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Edit node — <span className="font-mono">{node.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-display-name">
              Display name (alias)
            </label>
            <input
              id="node-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={63}
              className={INPUT_CLASS}
              placeholder={node.name}
              data-testid="node-display-name-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Operator-friendly label shown in the UI. Empty falls back to <span className="font-mono">{node.name}</span>.
              The k8s identity stays the same.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-role">Role</label>
              <select
                id="node-role"
                value={role}
                onChange={(e) => setRole(e.target.value as 'server' | 'worker')}
                className={INPUT_CLASS}
              >
                <option value="server">server (runs system workloads)</option>
                <option value="worker">worker (tenants only)</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Demoting a server with system pods still on it requires Force.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-can-host">
                Can host client workloads
              </label>
              <select
                id="node-can-host"
                value={canHost ? 'true' : 'false'}
                onChange={(e) => setCanHost(e.target.value === 'true')}
                className={INPUT_CLASS}
              >
                <option value="true">Yes — tenant pods may schedule here</option>
                <option value="false">No — NoSchedule taint for tenant pods</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Servers default to No; workers default to Yes.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-ingress-mode">
              Ingress mode
            </label>
            <select
              id="node-ingress-mode"
              value={ingressMode}
              onChange={(e) => setIngressMode(e.target.value as NodeIngressMode)}
              className={INPUT_CLASS}
              data-testid="node-ingress-mode-select"
            >
              {INGRESS_MODE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {INGRESS_MODE_OPTIONS.find((o) => o.value === ingressMode)?.hint}
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-notes">
              Operator notes
            </label>
            <textarea
              id="node-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              className={INPUT_CLASS}
              placeholder="Free text — surfaced only in this admin UI."
            />
          </div>

          {isDemotion && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <div>
                Demoting a server to worker evicts any system pods still running on it. The API will refuse unless you drain first or set Force.
                <label className="mt-1.5 flex items-center gap-2">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  <span>Force — bypass the safety check</span>
                </label>
              </div>
            </div>
          )}

          {err && !isDemotionBlocked && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {err.message}
            </p>
          )}
          {isDemotionBlocked && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> Demotion blocked — tick Force to override.
            </p>
          )}

          {update.isSuccess && (
            <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle size={12} /> Saved.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={update.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid={`save-node-${node.name}-button`}
          >
            {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
