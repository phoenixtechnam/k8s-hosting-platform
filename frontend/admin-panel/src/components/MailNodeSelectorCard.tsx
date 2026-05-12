import { useState, useEffect } from 'react';
import {
  Server,
  AlertTriangle,
  Loader2,
  Check,
} from 'lucide-react';
import { useMailNodeSelector, useUpdateMailNodeSelector } from '@/hooks/use-mail-node-selector';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import type { MailNodeSelectorMode } from '@k8s-hosting/api-contracts';

/**
 * Email Management → Mail Server Node Placement card.
 *
 * When using CIFS BlobStore, Stalwart MUST run on the specific node
 * where the kernel CIFS mount exists. This card lets operators control
 * the Stalwart pod's nodeAffinity:
 *
 *   any       — no affinity, pod floats freely (default)
 *   preferred — soft pin: k8s prefers this node but will use others if down
 *   required  — hard pin: pod only schedules here; unavailable if node down
 *
 * The platform auto-sets mode='required' when switching to CIFS and
 * reverts to 'any' when switching away, but operators may override.
 */
export function MailNodeSelectorCard() {
  const selector = useMailNodeSelector();
  const nodesQuery = useClusterNodes();
  const update = useUpdateMailNodeSelector();

  const [draftMode, setDraftMode] = useState<MailNodeSelectorMode>('any');
  const [draftNode, setDraftNode] = useState<string>('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Initialise draft from server data once loaded
  useEffect(() => {
    if (selector.data?.data) {
      setDraftMode(selector.data.data.mode);
      setDraftNode(selector.data.data.nodeName ?? '');
    }
  }, [selector.data]);

  if (selector.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading node selector…
        </div>
      </div>
    );
  }

  if (selector.isError || !selector.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read mail node selector.{' '}
            {selector.error instanceof Error ? selector.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const current = selector.data.data;
  const nodes = nodesQuery.data?.data ?? [];

  const nodeRequired = draftMode === 'preferred' || draftMode === 'required';
  const hasChange =
    draftMode !== current.mode ||
    (nodeRequired && draftNode !== (current.nodeName ?? '')) ||
    (!nodeRequired && current.nodeName !== null);

  function isNodeReady(nodeName: string): boolean {
    const node = nodes.find((n) => n.name === nodeName);
    if (!node || !node.statusConditions) return false;
    return node.statusConditions.some(
      (c) => c.type === 'Ready' && c.status === 'True',
    );
  }

  async function handleSave() {
    try {
      await update.mutateAsync({
        mode: draftMode,
        nodeName: nodeRequired && draftNode ? draftNode : null,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 6_000);
    } catch {
      // surfaced via update.isError below
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Server size={20} className="text-gray-700 dark:text-gray-300" />
        <h2
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          data-testid="mail-node-selector-heading"
        >
          Mail Server Node Placement
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Control which cluster node the Stalwart mail server pod can be scheduled on.
        Required when using CIFS blob storage, where the kernel CIFS mount is
        per-node (hostPath) and only exists on the node where it was mounted.
      </p>

      {current.currentNode ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-3 text-sm">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Currently running on
          </span>
          <div
            data-testid="mail-node-selector-current-node"
            className="font-mono text-sm text-gray-900 dark:text-gray-100 mt-0.5"
          >
            {current.currentNode}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Scheduling mode
        </div>

        <NodeSelectorRadio
          value="any"
          checked={draftMode === 'any'}
          onChange={() => {
            setDraftMode('any');
            setDraftNode('');
          }}
          label="Any node (default)"
          description="Pod floats freely. Kubernetes scheduler picks the best available node. No affinity rules applied."
          testId="mail-node-selector-radio-any"
        />

        <NodeSelectorRadio
          value="preferred"
          checked={draftMode === 'preferred'}
          onChange={() => setDraftMode('preferred')}
          label="Prefer node"
          description="Soft pin: Kubernetes prefers the selected node but will schedule on others if it is unavailable."
          testId="mail-node-selector-radio-preferred"
        />

        <NodeSelectorRadio
          value="required"
          checked={draftMode === 'required'}
          onChange={() => setDraftMode('required')}
          label="Require node"
          description="Hard pin: pod only schedules on the selected node. If the node goes down, Stalwart is unavailable."
          testId="mail-node-selector-radio-required"
        />
      </div>

      {nodeRequired ? (
        <div className="space-y-1.5">
          <label
            htmlFor="mail-node-selector-node"
            className="block text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
          >
            Target node
          </label>

          {nodesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <Loader2 size={12} className="animate-spin" /> Loading nodes…
            </div>
          ) : (
            <select
              id="mail-node-selector-node"
              value={draftNode}
              onChange={(e) => setDraftNode(e.target.value)}
              data-testid="mail-node-selector-node-select"
              className="w-full max-w-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">— select a node —</option>
              {nodes.map((node) => {
                const ready = isNodeReady(node.name);
                const label = node.displayName
                  ? `${node.displayName} (${node.name})`
                  : node.name;
                return (
                  <option key={node.name} value={node.name}>
                    {label} — {ready ? 'Ready' : 'NotReady'}
                  </option>
                );
              })}
            </select>
          )}

          {current.currentNode && draftNode === current.currentNode ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Currently running on: <code className="font-mono">{current.currentNode}</code>
            </p>
          ) : current.currentNode && draftNode && draftNode !== current.currentNode ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Stalwart pod will be rescheduled to{' '}
              <code className="font-mono">{draftNode}</code>.
            </p>
          ) : null}
        </div>
      ) : null}

      {draftMode === 'required' ? (
        <div
          role="note"
          className="flex items-start gap-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200"
          data-testid="mail-node-selector-required-warning"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            If the selected node becomes unavailable, Stalwart will be down until
            the node recovers or you change this setting.
          </span>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChange || update.isPending || (nodeRequired && !draftNode)}
          data-testid="mail-node-selector-save"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {update.isPending ? 'Saving…' : 'Save'}
        </button>

        {!hasChange ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">No changes to save.</p>
        ) : null}
      </div>

      {saveSuccess && !update.isPending ? (
        <div
          role="status"
          data-testid="mail-node-selector-success"
          className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-sm text-green-800 dark:text-green-200"
        >
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>Node selector updated. Stalwart pod will reschedule if needed.</span>
        </div>
      ) : null}

      {update.isError ? (
        <div
          role="alert"
          data-testid="mail-node-selector-error"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {update.error instanceof Error
              ? update.error.message
              : 'Save failed — see server logs.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface NodeSelectorRadioProps {
  readonly value: MailNodeSelectorMode;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly label: string;
  readonly description: string;
  readonly testId: string;
}
function NodeSelectorRadio({
  value,
  checked,
  onChange,
  label,
  description,
  testId,
}: NodeSelectorRadioProps) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
      <input
        type="radio"
        name="mail-node-selector-mode"
        value={value}
        checked={checked}
        onChange={onChange}
        data-testid={testId}
        className="mt-1"
      />
      <div className="flex-1">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>
      </div>
    </label>
  );
}
