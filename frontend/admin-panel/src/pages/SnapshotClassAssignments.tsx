import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2,
  TestTube,
  CheckCircle,
  AlertCircle,
  X,
  Save,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useSnapshotClasses,
  useSetAssignments,
  useTestSnapshotClass,
} from '@/hooks/use-snapshot-classes';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import type {
  SnapshotClass,
  ClassView,
  AssignmentInput,
} from '@k8s-hosting/api-contracts';

const CLASS_META: Record<SnapshotClass, { label: string; description: string }> = {
  tenant_snapshot: {
    label: 'Tenant PVC Snapshot',
    description: 'Per-tenant PVC tarballs (manual + pre-resize + pre-archive). Drives every tenant-level snapshot operation.',
  },
  tenant_bundle: {
    label: 'Tenant Backup Bundle',
    description: 'Plesk-style restore bundles (files + mailboxes + config + secrets). Operator + tenant-scheduled.',
  },
  system_snapshot: {
    label: 'System Snapshot',
    description: 'Generic platform metadata snapshots. Falls back here when no more specific class applies.',
  },
  system_etcd: {
    label: 'System etcd',
    description: 'etcd cluster backups. Recommended target: separate from tenant data for blast-radius isolation.',
  },
  system_secrets: {
    label: 'System Secrets',
    description: 'Tier-1 secrets bundle (encryption keys, root CA). Should target a separate / air-gapped location.',
  },
};

export default function SnapshotClassAssignments() {
  const { data, isLoading, error } = useSnapshotClasses();
  const { data: configsData } = useBackupConfigs();
  const configs = configsData?.data ?? [];
  const classes = data?.data?.classes ?? [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Snapshot Class Assignments
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Route each snapshot class to one or more backup targets. The strict-primary resolver
          picks the lowest-priority assignment per class; failover is manual reassignment.
          Classes with no assignment are <span className="font-medium text-rose-600 dark:text-rose-400">disabled</span> —
          snapshot operations of that class will fail loud with <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 text-[11px]">NO_SNAPSHOT_TARGET</code>.
          {' '}
          <Link to="/settings/backups" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
            Manage backup targets →
          </Link>
        </p>
      </header>

      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-gray-400" size={28} />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          Failed to load snapshot classes: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {configs.length === 0 && !isLoading && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          No backup targets configured yet.{' '}
          <Link to="/settings/backups" className="font-medium hover:underline">
            Configure one →
          </Link>
          {' '}before assigning classes.
        </div>
      )}

      <div className="space-y-4">
        {classes.map((cls) => (
          <ClassRow
            key={cls.snapshotClass}
            view={cls}
            availableTargets={configs.map((c) => ({ id: c.id, name: c.name, storageType: c.storageType }))}
          />
        ))}
      </div>
    </div>
  );
}

interface AvailableTarget {
  readonly id: string;
  readonly name: string;
  readonly storageType: string;
}

interface DraftAssignment {
  readonly targetId: string;
  readonly priority: number;
}

function toDraft(view: ClassView): DraftAssignment[] {
  return view.assignments.map((a) => ({ targetId: a.targetId, priority: a.priority }));
}

function nextPriority(existing: DraftAssignment[]): number {
  if (existing.length === 0) return 100;
  const max = Math.max(...existing.map((a) => a.priority));
  return max + 100;
}

function ClassRow({
  view,
  availableTargets,
}: {
  readonly view: ClassView;
  readonly availableTargets: readonly AvailableTarget[];
}) {
  const meta = CLASS_META[view.snapshotClass];
  // INTENTIONAL: draft is seeded once at mount and NOT synced from `view`
  // on subsequent renders. Adding a useEffect to sync would silently
  // discard the operator's unsaved edits when a sibling ClassRow's save
  // triggers a parent refetch. The save path overwrites draft via
  // setDraft(toDraft(...)) after a successful mutation; revert is the
  // explicit "throw away local edits" affordance.
  const [draft, setDraft] = useState<DraftAssignment[]>(toDraft(view));
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const setAssignments = useSetAssignments();
  const testClass = useTestSnapshotClass();
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);

  const sortedDraft = useMemo(() => [...draft].sort((a, b) => a.priority - b.priority), [draft]);
  const usedTargetIds = useMemo(() => new Set(draft.map((d) => d.targetId)), [draft]);
  const availableForAdd = availableTargets.filter((t) => !usedTargetIds.has(t.id));

  // (serverSig/draftSig were used during development for diff debugging —
  //  removed from the UI; the dirty flag is the operator-facing signal.)

  const handleAdd = (targetId: string) => {
    if (!targetId) return;
    setDraft((d) => [...d, { targetId, priority: nextPriority(d) }]);
    setDirty(true);
  };

  const handleRemove = (targetId: string) => {
    setDraft((d) => d.filter((a) => a.targetId !== targetId));
    setDirty(true);
  };

  const handlePriorityChange = (targetId: string, raw: string) => {
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return;
    setDraft((d) => d.map((a) => (a.targetId === targetId ? { ...a, priority: parsed } : a)));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaveError(null);
    // Validate locally for nice error messages before the API rejects.
    const priorities = draft.map((a) => a.priority);
    const dupPriority = priorities.find((p, i) => priorities.indexOf(p) !== i);
    if (dupPriority !== undefined) {
      setSaveError(`Two targets share priority ${dupPriority}. Pick distinct priorities.`);
      return;
    }
    const input: { assignments: AssignmentInput[] } = {
      assignments: draft.map((a) => ({ targetId: a.targetId, priority: a.priority })),
    };
    try {
      await setAssignments.mutateAsync({ snapshotClass: view.snapshotClass, input });
      setDirty(false);
      setTestResult(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevert = () => {
    setDraft(toDraft(view));
    setDirty(false);
    setSaveError(null);
  };

  const handleTest = async () => {
    try {
      const res = await testClass.mutateAsync(view.snapshotClass);
      const r = res.data;
      setTestResult({
        ok: r.ok,
        latencyMs: r.latencyMs,
        message: r.ok
          ? `Primary target "${r.targetName}" reachable.`
          : `${r.error?.code ?? 'PROBE_FAILED'}: ${r.error?.message ?? 'unknown'}`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const hasAssignments = sortedDraft.length > 0;
  const persistedHasAssignments = view.assignments.length > 0;

  return (
    <div
      className={clsx(
        'rounded-xl border bg-white dark:bg-gray-800 shadow-sm',
        persistedHasAssignments
          ? 'border-gray-200 dark:border-gray-700'
          : 'border-rose-200 dark:border-rose-800',
      )}
      data-testid={`snapshot-class-row-${view.snapshotClass}`}
    >
      <div className="border-b border-gray-100 dark:border-gray-700 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{meta.label}</h2>
              <code className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-400">
                {view.snapshotClass}
              </code>
              {!persistedHasAssignments && (
                <span className="rounded bg-rose-100 dark:bg-rose-900/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
                  Disabled
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-3xl">{meta.description}</p>
          </div>
          <button
            type="button"
            onClick={handleTest}
            disabled={testClass.isPending || !persistedHasAssignments}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid={`test-class-${view.snapshotClass}`}
          >
            {testClass.isPending ? <Loader2 size={12} className="animate-spin" /> : <TestTube size={12} />}
            Test Primary
          </button>
        </div>
        {testResult && (
          <div className={clsx(
            'mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
            testResult.ok
              ? 'border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
              : 'border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300',
          )}>
            {testResult.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            <span>{testResult.message}</span>
            {testResult.latencyMs > 0 && <span className="text-gray-500 dark:text-gray-400">({testResult.latencyMs}ms)</span>}
          </div>
        )}
      </div>

      <div className="p-4">
        {!hasAssignments ? (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-5 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            No targets assigned. {availableForAdd.length === 0 ? 'Configure a backup target first.' : 'Pick one from the dropdown below.'}
          </div>
        ) : (
          <div className="space-y-2">
            {sortedDraft.map((draftRow, idx) => {
              const target = availableTargets.find((t) => t.id === draftRow.targetId);
              const isPrimary = idx === 0;
              return (
                <div
                  key={draftRow.targetId}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 px-3 py-2"
                  data-testid={`assignment-row-${view.snapshotClass}-${draftRow.targetId}`}
                >
                  {isPrimary && (
                    <span className="rounded bg-brand-100 dark:bg-brand-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-700 dark:text-brand-300">
                      Primary
                    </span>
                  )}
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {target?.name ?? draftRow.targetId}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      {target?.storageType ?? 'unknown'} · {draftRow.targetId.slice(0, 8)}…
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <label
                      htmlFor={`priority-${view.snapshotClass}-${draftRow.targetId}`}
                      className="text-[11px] text-gray-500 dark:text-gray-400"
                    >
                      Priority
                    </label>
                    <input
                      id={`priority-${view.snapshotClass}-${draftRow.targetId}`}
                      type="number"
                      min={0}
                      max={10000}
                      value={draftRow.priority}
                      onChange={(e) => handlePriorityChange(draftRow.targetId, e.target.value)}
                      className="w-20 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
                      data-testid={`priority-input-${view.snapshotClass}-${draftRow.targetId}`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(draftRow.targetId)}
                    className="rounded-md p-1 text-gray-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 hover:text-rose-600 dark:hover:text-rose-400"
                    data-testid={`remove-assignment-${view.snapshotClass}-${draftRow.targetId}`}
                    aria-label="Remove target"
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {availableForAdd.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <select
              defaultValue=""
              onChange={(e) => { handleAdd(e.target.value); e.target.value = ''; }}
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
              data-testid={`add-target-select-${view.snapshotClass}`}
            >
              <option value="" disabled>Add a target…</option>
              {availableForAdd.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.storageType})
                </option>
              ))}
            </select>
          </div>
        )}

        {saveError && (
          <div
            className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 text-xs text-rose-700 dark:text-rose-300"
            role="alert"
            data-testid={`save-error-${view.snapshotClass}`}
          >
            <AlertCircle size={14} className="mt-0.5 flex-none" />
            <span>{saveError}</span>
          </div>
        )}

        {dirty && (
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-gray-100 dark:border-gray-700 pt-3">
            <span className="mr-auto text-[11px] font-medium text-amber-700 dark:text-amber-400">
              Unsaved changes
            </span>
            <button
              type="button"
              onClick={handleRevert}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Revert
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={setAssignments.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid={`save-class-${view.snapshotClass}`}
            >
              {setAssignments.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save assignments
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
