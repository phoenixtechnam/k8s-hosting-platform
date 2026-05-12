// Single-container deploy wizard. Single-step form (kept lean —
// progressive disclosure for advanced fields rather than multi-step
// gating). Calls /validate as a dry-run, surfaces the Issues pane,
// then POSTs on submit.

import { useState } from 'react';
import { AlertTriangle, Plus, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useCreateCustomDeployment, useValidateCustomDeployment } from '@/hooks/use-custom-deployments';
import type { CreateCustomDeploymentSimpleInput, CustomDeploymentIssue } from '@k8s-hosting/api-contracts';

interface Props {
  readonly clientId: string;
  readonly existingNames: readonly string[];
  readonly onClose: () => void;
  readonly onCreated: () => void;
}

interface PortRow { containerPort: number; name: string; protocol: 'TCP' | 'UDP' | 'SCTP'; exposeAsService: boolean; ingressEligible: boolean }
interface VolumeRow { name: string; containerPath: string; readOnly: boolean }
interface EnvRow { name: string; value: string }

export function SimpleContainerWizard({ clientId, existingNames, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [ports, setPorts] = useState<PortRow[]>([{ containerPort: 80, name: 'http', protocol: 'TCP', exposeAsService: true, ingressEligible: true }]);
  const [volumes, setVolumes] = useState<VolumeRow[]>([]);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [cpuRequest, setCpuRequest] = useState('100m');
  const [memoryRequest, setMemoryRequest] = useState('128Mi');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [issues, setIssues] = useState<readonly CustomDeploymentIssue[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validateMutation = useValidateCustomDeployment(clientId);
  const createMutation = useCreateCustomDeployment(clientId);

  const buildInput = (): CreateCustomDeploymentSimpleInput => ({
    mode: 'simple',
    name,
    image,
    ports: ports.filter((p) => p.name && p.containerPort > 0),
    volumes: volumes.filter((v) => v.name && v.containerPath),
    env: env.filter((e) => e.name).map((e) => ({ name: e.name, value: e.value })),
    resources: { cpuRequest, memoryRequest },
  });

  const nameError = (() => {
    if (!name) return null;
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return 'lowercase letters, digits, hyphens; start/end alphanumeric';
    if (existingNames.includes(name)) return 'name already in use';
    return null;
  })();

  const canSubmit = Boolean(name && image && !nameError && !createMutation.isPending);

  const runValidate = async () => {
    setSubmitError(null);
    try {
      const r = await validateMutation.mutateAsync(buildInput());
      setIssues(r.data.issues);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'validation failed');
    }
  };

  const submit = async () => {
    setSubmitError(null);
    setIssues([]);
    try {
      await createMutation.mutateAsync(buildInput());
      onCreated();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'create failed');
    }
  };

  const errorIssues = issues.filter((i) => i.severity === 'error');
  const warningIssues = issues.filter((i) => i.severity === 'warning');

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Deploy a custom container</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Single image, declared ports + named volumes. For multi-service stacks use the compose editor.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Name + image */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Deployment name" hint="DNS-compatible, unique within your account.">
              <input
                type="text"
                className={inputCls(Boolean(nameError))}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-app"
                data-testid="custom-simple-name"
              />
              {nameError && <FieldError>{nameError}</FieldError>}
            </Field>
            <Field label="Image" hint="Any registry. PATs via the PAT modal after create.">
              <input
                type="text"
                className={inputCls(false)}
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="nginx:1.27"
                data-testid="custom-simple-image"
              />
            </Field>
          </div>

          {/* Ports */}
          <section>
            <SectionHeader title="Ports" hint="Each exposed port becomes a ClusterIP Service. One can be ingress-eligible.">
              <button type="button" className={addBtnCls} onClick={() => setPorts([...ports, { containerPort: 0, name: '', protocol: 'TCP', exposeAsService: true, ingressEligible: false }])}>
                <Plus size={14} /> Port
              </button>
            </SectionHeader>
            {ports.length === 0 && <Empty>No ports declared.</Empty>}
            {ports.map((p, i) => (
              <div key={i} className="grid grid-cols-12 items-center gap-2 py-1">
                <input type="number" className={clsx(inputCls(false), 'col-span-2')} value={p.containerPort || ''} onChange={(e) => setPorts(rowsUpdate(ports, i, { containerPort: parseInt(e.target.value, 10) || 0 }))} placeholder="80" />
                <input type="text" className={clsx(inputCls(false), 'col-span-3')} value={p.name} onChange={(e) => setPorts(rowsUpdate(ports, i, { name: e.target.value }))} placeholder="http" />
                <select className={clsx(inputCls(false), 'col-span-2')} value={p.protocol} onChange={(e) => setPorts(rowsUpdate(ports, i, { protocol: e.target.value as 'TCP' | 'UDP' | 'SCTP' }))}>
                  <option>TCP</option><option>UDP</option><option>SCTP</option>
                </select>
                <label className="col-span-2 flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                  <input type="checkbox" checked={p.exposeAsService} onChange={(e) => setPorts(rowsUpdate(ports, i, { exposeAsService: e.target.checked }))} />
                  Service
                </label>
                <label className="col-span-2 flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                  <input type="checkbox" checked={p.ingressEligible} onChange={(e) => setPorts(rowsUpdate(ports, i, { ingressEligible: e.target.checked }))} />
                  Ingress
                </label>
                <button type="button" className="col-span-1 text-gray-400 hover:text-red-500" onClick={() => setPorts(ports.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </section>

          {/* Volumes */}
          <section>
            <SectionHeader title="Volumes" hint="Named only. Stored as subPath on your tenant PVC.">
              <button type="button" className={addBtnCls} onClick={() => setVolumes([...volumes, { name: '', containerPath: '', readOnly: false }])}>
                <Plus size={14} /> Volume
              </button>
            </SectionHeader>
            {volumes.length === 0 && <Empty>No volumes declared.</Empty>}
            {volumes.map((v, i) => (
              <div key={i} className="grid grid-cols-12 items-center gap-2 py-1">
                <input type="text" className={clsx(inputCls(false), 'col-span-3')} value={v.name} onChange={(e) => setVolumes(rowsUpdate(volumes, i, { name: e.target.value }))} placeholder="data" />
                <input type="text" className={clsx(inputCls(false), 'col-span-6')} value={v.containerPath} onChange={(e) => setVolumes(rowsUpdate(volumes, i, { containerPath: e.target.value }))} placeholder="/var/lib/data" />
                <label className="col-span-2 flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                  <input type="checkbox" checked={v.readOnly} onChange={(e) => setVolumes(rowsUpdate(volumes, i, { readOnly: e.target.checked }))} />
                  Read-only
                </label>
                <button type="button" className="col-span-1 text-gray-400 hover:text-red-500" onClick={() => setVolumes(volumes.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </section>

          {/* Env */}
          <section>
            <SectionHeader title="Environment" hint="KEY=value. Use the PAT modal for credentials.">
              <button type="button" className={addBtnCls} onClick={() => setEnv([...env, { name: '', value: '' }])}>
                <Plus size={14} /> Env
              </button>
            </SectionHeader>
            {env.length === 0 && <Empty>No env vars declared.</Empty>}
            {env.map((row, i) => (
              <div key={i} className="grid grid-cols-12 items-center gap-2 py-1">
                <input type="text" className={clsx(inputCls(false), 'col-span-4')} value={row.name} onChange={(e) => setEnv(rowsUpdate(env, i, { name: e.target.value }))} placeholder="DB_HOST" />
                <input type="text" className={clsx(inputCls(false), 'col-span-7')} value={row.value} onChange={(e) => setEnv(rowsUpdate(env, i, { value: e.target.value }))} placeholder="localhost" />
                <button type="button" className="col-span-1 text-gray-400 hover:text-red-500" onClick={() => setEnv(env.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </section>

          {/* Resources */}
          <button type="button" className="text-xs text-blue-600 hover:underline dark:text-blue-400" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? 'Hide' : 'Show'} advanced (resources)
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="CPU request" hint="e.g. 100m, 250m, 1">
                <input type="text" className={inputCls(false)} value={cpuRequest} onChange={(e) => setCpuRequest(e.target.value)} />
              </Field>
              <Field label="Memory request" hint="e.g. 128Mi, 1Gi">
                <input type="text" className={inputCls(false)} value={memoryRequest} onChange={(e) => setMemoryRequest(e.target.value)} />
              </Field>
            </div>
          )}

          {/* Issues panel */}
          {(errorIssues.length > 0 || warningIssues.length > 0) && (
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
                <AlertTriangle size={14} /> Issues ({errorIssues.length} error, {warningIssues.length} warning)
              </h4>
              <ul className="space-y-1 text-xs">
                {issues.map((iss, i) => (
                  <li key={i} className={clsx(
                    iss.severity === 'error' ? 'text-red-600 dark:text-red-400'
                      : iss.severity === 'warning' ? 'text-amber-600 dark:text-amber-400'
                        : 'text-gray-500 dark:text-gray-400',
                  )}>
                    <strong className="font-mono">{iss.code}</strong> {iss.path && <>· {iss.path}</>} — {iss.message}
                    {iss.hint && <div className="ml-4 text-gray-500 dark:text-gray-400">↪ {iss.hint}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {submitError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {submitError}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-gray-200 px-6 py-3 dark:border-gray-700">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button type="button" onClick={runValidate} disabled={!image || validateMutation.isPending} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
            {validateMutation.isPending ? 'Validating…' : 'Validate'}
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="custom-simple-submit">
            {createMutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Form-row helpers ───────────────────────────────────────────────────────

const inputCls = (error: boolean) =>
  clsx(
    'w-full rounded-md border px-2 py-1 text-sm dark:bg-gray-800 dark:text-gray-100',
    error
      ? 'border-red-300 focus:border-red-500 dark:border-red-700'
      : 'border-gray-300 focus:border-blue-500 dark:border-gray-600',
  );

const addBtnCls = 'inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{children}</p>;
}

function SectionHeader({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between">
      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{title}</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs italic text-gray-400 dark:text-gray-500">{children}</p>;
}

function rowsUpdate<T>(rows: readonly T[], i: number, patch: Partial<T>): T[] {
  return rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
}
