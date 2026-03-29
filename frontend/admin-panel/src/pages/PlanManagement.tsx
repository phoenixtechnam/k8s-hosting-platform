import { useState, type FormEvent } from 'react';
import { CreditCard, Plus, Loader2, AlertCircle, Trash2, Edit, X, Save } from 'lucide-react';
import clsx from 'clsx';
import { usePlans } from '@/hooks/use-plans';
import { useCreatePlan, useUpdatePlan, useDeletePlan } from '@/hooks/use-plan-management';

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

interface PlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly storageLimit: string;
  readonly monthlyPriceUsd: string;
  readonly maxSubUsers: number;
  readonly status: string;
}

export default function PlanManagement() {
  const { data: plansData, isLoading } = usePlans();
  const plans = (plansData?.data ?? []) as readonly PlanRow[];
  const [showAdd, setShowAdd] = useState(false);

  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;

  return (
    <div className="space-y-6" data-testid="plan-management-page">
      <div className="flex items-center gap-3">
        <CreditCard size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Hosting Plans</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage hosting plans and resource limits.</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Plans</h2>
          <button type="button" onClick={() => setShowAdd((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-plan-button">
            {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'Add Plan'}
          </button>
        </div>

        {showAdd && <PlanForm onClose={() => setShowAdd(false)} />}

        {plans.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No hosting plans configured.</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">{plans.map((p) => <PlanRowComp key={p.id} plan={p} />)}</div>
        )}
      </div>
    </div>
  );
}

function PlanForm({ onClose, initial }: { readonly onClose: () => void; readonly initial?: PlanRow }) {
  const create = useCreatePlan();
  const update = useUpdatePlan();
  const isEdit = Boolean(initial);

  const [form, setForm] = useState({
    code: initial?.code ?? '', name: initial?.name ?? '', description: initial?.description ?? '',
    cpu_limit: initial?.cpuLimit ?? '0.50', memory_limit: initial?.memoryLimit ?? '1.00',
    storage_limit: initial?.storageLimit ?? '10.00', monthly_price_usd: initial?.monthlyPriceUsd ?? '5.00',
    max_sub_users: String(initial?.maxSubUsers ?? 3),
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const payload = { ...form, max_sub_users: Number(form.max_sub_users) };
    try {
      if (isEdit && initial) { await update.mutateAsync({ id: initial.id, ...payload }); }
      else { await create.mutateAsync(payload); }
      onClose();
    } catch {}
  };

  const error = isEdit ? update.error : create.error;
  const isPending = isEdit ? update.isPending : create.isPending;

  return (
    <form onSubmit={handleSubmit} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3" data-testid={isEdit ? 'edit-plan-form' : 'add-plan-form'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Code</label><input type="text" className={INPUT_CLASS} placeholder="starter" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required disabled={isEdit} data-testid="plan-code-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label><input type="text" className={INPUT_CLASS} placeholder="Starter" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="plan-name-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Price (USD/mo)</label><input type="text" className={INPUT_CLASS} placeholder="5.00" value={form.monthly_price_usd} onChange={(e) => setForm({ ...form, monthly_price_usd: e.target.value })} required data-testid="plan-price-input" /></div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">CPU Limit (cores)</label><input type="text" className={INPUT_CLASS} value={form.cpu_limit} onChange={(e) => setForm({ ...form, cpu_limit: e.target.value })} required /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Memory Limit (GB)</label><input type="text" className={INPUT_CLASS} value={form.memory_limit} onChange={(e) => setForm({ ...form, memory_limit: e.target.value })} required /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Storage Limit (GB)</label><input type="text" className={INPUT_CLASS} value={form.storage_limit} onChange={(e) => setForm({ ...form, storage_limit: e.target.value })} required /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Max Sub-Users</label><input type="number" className={INPUT_CLASS} value={form.max_sub_users} onChange={(e) => setForm({ ...form, max_sub_users: e.target.value })} /></div>
      </div>
      <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Description</label><input type="text" className={INPUT_CLASS} placeholder="Optional description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      {error && <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{error instanceof Error ? error.message : 'Failed'}</div>}
      <div className="flex gap-2 justify-end">
        {isEdit && <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>}
        <button type="submit" disabled={isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-plan">{isPending && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Save' : 'Add Plan'}</button>
      </div>
    </form>
  );
}

function PlanRowComp({ plan }: { readonly plan: PlanRow }) {
  const update = useUpdatePlan();
  const del = useDeletePlan();
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  if (editing) return <PlanForm initial={plan} onClose={() => setEditing(false)} />;

  const isDeprecated = plan.status === 'deprecated';

  return (
    <div className={clsx('px-5 py-4', isDeprecated && 'opacity-50')} data-testid={`plan-${plan.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{plan.name}</span>
            <span className="ml-2 rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-mono text-gray-600 dark:text-gray-400">{plan.code}</span>
            {isDeprecated && <span className="ml-2 rounded bg-red-100 dark:bg-red-900/20 px-2 py-0.5 text-xs text-red-600 dark:text-red-400">deprecated</span>}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
          <span>${plan.monthlyPriceUsd}/mo</span>
          <span>{plan.cpuLimit} CPU</span>
          <span>{plan.memoryLimit}GB RAM</span>
          <span>{plan.storageLimit}GB disk</span>
          <span>{plan.maxSubUsers} users</span>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`edit-plan-${plan.id}`}><Edit size={12} /></button>
            {confirmDel ? (
              <><button type="button" onClick={async () => { await del.mutateAsync(plan.id); setConfirmDel(false); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button><button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button></>
            ) : (
              <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md border border-red-200 dark:border-red-800 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-plan-${plan.id}`}><Trash2 size={12} /></button>
            )}
          </div>
        </div>
      </div>
      {plan.description && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{plan.description}</p>}
    </div>
  );
}
