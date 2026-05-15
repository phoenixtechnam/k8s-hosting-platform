import { useState, useEffect } from 'react';
import {
  ShieldAlert,
  AlertTriangle,
  Loader2,
  Check,
  ArrowRight,
  RefreshCw,
  ChevronDown,
  Info,
} from 'lucide-react';
import {
  useMailPlacement,
  useUpdateMailPlacement,
  useMailFailover,
  useMailFailback,
  PLACEMENT_KEY,
} from '@/hooks/use-mail-placement';
import { useStartMailMigration } from '@/hooks/use-mail-migration';
import { useQueryClient } from '@tanstack/react-query';
import MailMigrationProgressModal from '@/components/MailMigrationProgressModal';
import type { NodeCandidate } from '@k8s-hosting/api-contracts';

type DrState = 'healthy' | 'degraded' | 'failing-over' | 'failed-over' | 'failing-back';

const DR_STATE_BADGE: Record<DrState, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  degraded: { label: 'Degraded', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  'failing-over': { label: 'Failing over…', cls: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
  'failed-over': { label: 'Failed over', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  'failing-back': { label: 'Failing back…', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
};

function bytesToGiB(b: number) { return (b / 1024 ** 3).toFixed(1); }

export default function MailDrCard() {
  const query = useMailPlacement();
  const update = useUpdateMailPlacement();
  const failover = useMailFailover();
  const failback = useMailFailback();
  const migrate = useStartMailMigration();
  const qc = useQueryClient();

  const [draft, setDraft] = useState<{
    primaryNode: string | null;
    secondaryNode: string | null;
    tertiaryNode: string | null;
    autoFailoverEnabled: boolean;
    failoverThresholdSeconds: number;
  } | null>(null);

  const [migrationRunId, setMigrationRunId] = useState<string | null>(null);
  const [failoverTarget, setFailoverTarget] = useState<string | null>(null);
  const [migrateTarget, setMigrateTarget] = useState<string>('');
  const [showMigrateForm, setShowMigrateForm] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Init draft from server data
  useEffect(() => {
    if (query.data?.data && !draft) {
      const d = query.data.data;
      setDraft({
        primaryNode: d.primaryNode,
        secondaryNode: d.secondaryNode,
        tertiaryNode: d.tertiaryNode,
        autoFailoverEnabled: d.autoFailoverEnabled,
        failoverThresholdSeconds: d.failoverThresholdSeconds,
      });
    }
  }, [query.data, draft]);

  if (query.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading placement policy…
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read mail placement policy.{' '}
            {query.error instanceof Error ? query.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const current = query.data.data;
  const candidates = current.candidateNodes;
  const drState = current.drState as DrState;
  const badge = DR_STATE_BADGE[drState] ?? DR_STATE_BADGE.healthy;

  const d = draft ?? {
    primaryNode: current.primaryNode,
    secondaryNode: current.secondaryNode,
    tertiaryNode: current.tertiaryNode,
    autoFailoverEnabled: current.autoFailoverEnabled,
    failoverThresholdSeconds: current.failoverThresholdSeconds,
  };

  const hasChange =
    d.primaryNode !== current.primaryNode ||
    d.secondaryNode !== current.secondaryNode ||
    d.tertiaryNode !== current.tertiaryNode ||
    d.autoFailoverEnabled !== current.autoFailoverEnabled ||
    d.failoverThresholdSeconds !== current.failoverThresholdSeconds;

  const selectedNodes = [d.primaryNode, d.secondaryNode, d.tertiaryNode].filter(Boolean) as string[];
  const hasDuplicates = new Set(selectedNodes).size < selectedNodes.length;

  async function handleSave() {
    if (hasDuplicates) return;
    try {
      await update.mutateAsync({
        primaryNode: d.primaryNode,
        secondaryNode: d.secondaryNode,
        tertiaryNode: d.tertiaryNode,
        autoFailoverEnabled: d.autoFailoverEnabled,
        failoverThresholdSeconds: d.failoverThresholdSeconds,
      });
      setDraft(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 5_000);
    } catch {
      // Failed mutation: drop the draft so the form re-syncs to
      // server state on the next render. Without this the operator
      // is left looking at their stale local selection while the
      // banner says "save failed", with no clear path to retry from
      // the actual server state.
      setDraft(null);
    }
  }

  async function handleFailover() {
    try {
      const result = await failover.mutateAsync({ targetNode: failoverTarget, confirm: true });
      setMigrationRunId(result.data.runId);
      setFailoverTarget(null);
    } catch {
      // surfaced via failover.isError
    }
  }

  async function handleFailback() {
    try {
      const result = await failback.mutateAsync({ confirm: true });
      setMigrationRunId(result.data.runId);
    } catch {
      // surfaced via failback.isError
    }
  }

  async function handleMigrate() {
    if (!migrateTarget) return;
    try {
      const result = await migrate.mutateAsync({ targetNode: migrateTarget, confirm: true });
      setMigrationRunId(result.data.runId);
      setShowMigrateForm(false);
      setMigrateTarget('');
    } catch {
      // surfaced via migrate.isError
    }
  }

  const canFailback = current.activeNode && current.primaryNode && current.activeNode !== current.primaryNode;
  const failoverTargetNode = failoverTarget ?? current.secondaryNode ?? current.tertiaryNode ?? null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="mail-dr-heading">
            Mail Server Placement &amp; DR
          </h2>
        </div>
        <span
          data-testid="mail-dr-state-badge"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badge.cls}`}
        >
          {drState === 'failing-over' || drState === 'failing-back'
            ? <Loader2 size={11} className="animate-spin" />
            : null}
          {badge.label}
        </span>
      </div>

      {/* Phase 3 streamline (2026-05-15): the "Currently running on" tile
          was removed from this card — it read from system_settings.
          activeNode which can drift from the pod's real node. The health
          banner above shows the verified pod node (probed live from k8s).
          We only render the last-failover timestamp here as it's not
          available from the health endpoint. */}
      {current.lastFailoverAt && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
          Last failover: {new Date(current.lastFailoverAt).toLocaleString()}
        </div>
      )}
      {/* Keep activeNode as a data attribute for the harness without
          rendering it visibly — harness Phase G4 reads it via the
          test-id to compare against `kubectl get pod`. */}
      {current.activeNode && (
        <span data-testid="mail-dr-active-node" className="sr-only">{current.activeNode}</span>
      )}

      {/* Node assignments */}
      <div className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Node assignment
        </div>

        <NodeDropdown
          label="Primary"
          description="Default node for Stalwart. DR will try to keep mail here."
          value={d.primaryNode}
          candidates={candidates}
          disabledValues={[d.secondaryNode, d.tertiaryNode]}
          onChange={(v) => setDraft({ ...d, primaryNode: v })}
          testId="mail-dr-primary-node"
        />
        <NodeDropdown
          label="Secondary"
          description="First failover target when primary is unavailable."
          value={d.secondaryNode}
          candidates={candidates}
          disabledValues={[d.primaryNode, d.tertiaryNode]}
          onChange={(v) => setDraft({ ...d, secondaryNode: v })}
          testId="mail-dr-secondary-node"
        />
        <NodeDropdown
          label="Tertiary"
          description="Second failover target (optional)."
          value={d.tertiaryNode}
          candidates={candidates}
          disabledValues={[d.primaryNode, d.secondaryNode]}
          onChange={(v) => setDraft({ ...d, tertiaryNode: v })}
          testId="mail-dr-tertiary-node"
        />
      </div>

      {hasDuplicates && (
        <p className="text-xs text-red-700 dark:text-red-300">
          Primary, secondary and tertiary must be distinct nodes.
        </p>
      )}

      {/* Auto-failover */}
      <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Auto-failover</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Automatically migrate to secondary/tertiary when primary is unreachable.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={d.autoFailoverEnabled}
            onClick={() => setDraft({ ...d, autoFailoverEnabled: !d.autoFailoverEnabled })}
            data-testid="mail-dr-auto-failover-toggle"
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
              d.autoFailoverEnabled ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                d.autoFailoverEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {d.autoFailoverEnabled && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Failover threshold: <strong>{d.failoverThresholdSeconds}s</strong>
            </label>
            <input
              type="range"
              min={60}
              max={3600}
              step={30}
              value={d.failoverThresholdSeconds}
              onChange={(e) => setDraft({ ...d, failoverThresholdSeconds: Number(e.target.value) })}
              data-testid="mail-dr-threshold-slider"
              className="w-full accent-brand-500"
            />
            <div className="flex justify-between text-xs text-gray-400 dark:text-gray-600">
              <span>60s</span><span>1h</span>
            </div>
          </div>
        )}
      </div>

      {/* Save placement */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChange || hasDuplicates || update.isPending}
          data-testid="mail-dr-save"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
        {!hasChange && <p className="text-xs text-gray-500 dark:text-gray-400">No changes to save.</p>}
      </div>

      {saveSuccess && (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-sm text-green-800 dark:text-green-200">
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>Placement policy saved.</span>
        </div>
      )}

      {update.isError && (
        <ErrorBanner error={update.error} />
      )}

      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Manual operations
        </div>

        {/* Failover */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
              Manual failover
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Migrate to secondary/tertiary immediately. Use when the primary is healthy
              but you need to move Stalwart (maintenance, hardware replacement).
            </p>
            <select
              value={failoverTarget ?? ''}
              onChange={(e) => setFailoverTarget(e.target.value || null)}
              data-testid="mail-dr-failover-target"
              className="w-full max-w-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 mb-2"
            >
              {current.secondaryNode && (
                <option value={current.secondaryNode}>
                  Secondary: {current.secondaryNode}
                </option>
              )}
              {current.tertiaryNode && (
                <option value={current.tertiaryNode}>
                  Tertiary: {current.tertiaryNode}
                </option>
              )}
              {!current.secondaryNode && !current.tertiaryNode && (
                <option value="" disabled>No secondary/tertiary configured</option>
              )}
            </select>
            <button
              type="button"
              onClick={handleFailover}
              disabled={!failoverTargetNode || failover.isPending}
              data-testid="mail-dr-failover-button"
              className="inline-flex items-center gap-2 rounded-lg border border-amber-500 bg-amber-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {failover.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              {failover.isPending ? 'Starting…' : 'Failover'}
            </button>
            {failover.isError && <ErrorBanner error={failover.error} />}
          </div>

          {/* Fail-back */}
          {canFailback && (
            <div className="flex-1 min-w-[200px]">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
                Fail-back to primary
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                Restore Stalwart to the primary node (
                <code className="font-mono">{current.primaryNode}</code>
                ). Data is rsynced back.
              </p>
              <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 mb-2">
                <Info size={12} className="shrink-0" />
                Operator-only — auto-failover cannot trigger fail-back.
              </div>
              <button
                type="button"
                onClick={handleFailback}
                disabled={failback.isPending}
                data-testid="mail-dr-failback-button"
                className="inline-flex items-center gap-2 rounded-lg border border-blue-500 bg-blue-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {failback.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {failback.isPending ? 'Starting…' : 'Fail-back'}
              </button>
              {failback.isError && <ErrorBanner error={failback.error} />}
            </div>
          )}
        </div>

        {/* Live migrate */}
        <div>
          <button
            type="button"
            onClick={() => setShowMigrateForm(!showMigrateForm)}
            className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            data-testid="mail-dr-migrate-toggle"
          >
            <ChevronDown
              size={14}
              className={`transition-transform ${showMigrateForm ? 'rotate-180' : ''}`}
            />
            Live migrate to any node
          </button>

          {showMigrateForm && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Migrate RocksDB data to a specific node via rsync. Use for planned maintenance
                or to resize by specifying a new size (optional).
              </p>
              <div className="flex items-end gap-2 flex-wrap">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Target node
                  </label>
                  <select
                    value={migrateTarget}
                    onChange={(e) => setMigrateTarget(e.target.value)}
                    data-testid="mail-dr-migrate-target"
                    className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="">— select node —</option>
                    {candidates.map((c) => (
                      <option key={c.hostname} value={c.hostname} disabled={c.hostname === current.activeNode}>
                        {c.hostname} ({bytesToGiB(c.freeDiskBytes)} GiB free)
                        {c.hostname === current.activeNode ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleMigrate}
                  disabled={!migrateTarget || migrate.isPending}
                  data-testid="mail-dr-migrate-button"
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-500 bg-gray-700 dark:bg-gray-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {migrate.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  {migrate.isPending ? 'Starting…' : 'Migrate'}
                </button>
              </div>
              {migrate.isError && <ErrorBanner error={migrate.error} />}
            </div>
          )}
        </div>
      </div>

      {/* Candidate nodes info */}
      {candidates.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1.5">
            <ChevronDown size={12} className="group-open:rotate-180 transition-transform" />
            {candidates.length} server node{candidates.length !== 1 ? 's' : ''} available
          </summary>
          <div className="mt-2 space-y-1.5">
            {candidates.map((c) => <CandidateRow key={c.hostname} candidate={c} active={c.hostname === current.activeNode} />)}
          </div>
        </details>
      )}

      {migrationRunId && (
        <MailMigrationProgressModal
          runId={migrationRunId}
          onClose={() => {
            setMigrationRunId(null);
            void qc.invalidateQueries({ queryKey: PLACEMENT_KEY });
          }}
        />
      )}
    </div>
  );
}

interface NodeDropdownProps {
  readonly label: string;
  readonly description: string;
  readonly value: string | null;
  readonly candidates: NodeCandidate[];
  readonly disabledValues: (string | null)[];
  readonly onChange: (v: string | null) => void;
  readonly testId: string;
}
function NodeDropdown({ label, description, value, candidates, disabledValues, onChange, testId }: NodeDropdownProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0">
        <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 pt-2">{label}</div>
      </div>
      <div className="flex-1">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          data-testid={testId}
          className="w-full max-w-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">Any node</option>
          {candidates.map((c) => (
            <option
              key={c.hostname}
              value={c.hostname}
              disabled={disabledValues.includes(c.hostname)}
            >
              {c.hostname} — {c.role} — {c.ready ? 'Ready' : 'NotReady'} — {bytesToGiB(c.freeDiskBytes)} GiB free
            </option>
          ))}
        </select>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p>
      </div>
    </div>
  );
}

function CandidateRow({ candidate, active }: { readonly candidate: NodeCandidate; readonly active: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-xs">
      <div className={`w-2 h-2 rounded-full shrink-0 ${candidate.ready ? 'bg-green-500' : 'bg-red-500'}`} />
      <code className="font-mono font-medium text-gray-900 dark:text-gray-100 flex-1">
        {candidate.hostname}
        {active && <span className="ml-1.5 text-brand-600 dark:text-brand-400">(active)</span>}
      </code>
      <span className="rounded bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:text-gray-300">
        {candidate.role}
      </span>
      <span className="text-gray-500 dark:text-gray-400">
        {bytesToGiB(candidate.freeDiskBytes)} GiB disk
      </span>
      <span className="text-gray-500 dark:text-gray-400">
        {bytesToGiB(candidate.freeMemoryBytes)} GiB RAM
      </span>
    </div>
  );
}

function ErrorBanner({ error }: { readonly error: unknown }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300 mt-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{error instanceof Error ? error.message : 'Operation failed — see server logs.'}</span>
    </div>
  );
}
