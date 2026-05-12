// Single-container deploy wizard. Single-step form (kept lean —
// progressive disclosure for advanced fields rather than multi-step
// gating). Calls /validate as a dry-run, surfaces the Issues pane,
// then POSTs on submit.

import { useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Loader2, Plus, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useCreateCustomDeployment, useUpdateCustomDeployment, useValidateCustomDeployment } from '@/hooks/use-custom-deployments';
import type { CreateCustomDeploymentSimpleInput, CustomDeploymentIssue, CustomDeploymentSpec } from '@k8s-hosting/api-contracts';
import type { CustomDeploymentRow } from '@/hooks/use-custom-deployments';
import { Tooltip } from '@/components/ui/Tooltip';

interface Props {
  readonly clientId: string;
  readonly existingNames: readonly string[];
  readonly onClose: () => void;
  readonly onCreated: () => void;
  /** When set, the wizard enters edit mode — pre-populated from this row. */
  readonly existingDeployment?: CustomDeploymentRow;
}

interface PortRow { containerPort: number; name: string; protocol: 'TCP' | 'UDP' | 'SCTP'; exposeAsService: boolean; ingressEligible: boolean }
interface VolumeRow { kind: 'volume'; name: string; containerPath: string; readOnly: boolean }
interface EnvRow { name: string; value: string }

function specToState(spec: CustomDeploymentSpec, depName: string) {
  const svc = spec.services[depName] ?? Object.values(spec.services)[0];
  return {
    image: svc?.image ?? '',
    ports: (svc?.ports ?? []).map(p => ({
      containerPort: p.containerPort,
      name: p.name ?? '',
      protocol: (p.protocol ?? 'TCP') as 'TCP' | 'UDP' | 'SCTP',
      exposeAsService: p.exposeAsService ?? true,
      ingressEligible: p.ingressEligible ?? false,
    })),
    volumes: (svc?.volumeMounts ?? []).filter(v => v.kind === 'volume').map(v => ({
      kind: 'volume' as const,
      name: v.name,
      containerPath: v.containerPath,
      readOnly: v.readOnly ?? false,
    })),
    env: (svc?.env ?? []).map(e => ({ name: e.name, value: e.value ?? '' })),
    cpuRequest: svc?.resources?.cpuRequest ?? '100m',
    memoryRequest: svc?.resources?.memoryRequest ?? '128Mi',
  };
}

export function SimpleContainerWizard({ clientId, existingNames, onClose, onCreated, existingDeployment }: Props) {
  const isEdit = Boolean(existingDeployment);
  const initState = existingDeployment
    ? specToState(existingDeployment.customSpec, existingDeployment.name)
    : { image: '', ports: [{ containerPort: 80, name: 'http', protocol: 'TCP' as const, exposeAsService: true, ingressEligible: true }], volumes: [], env: [], cpuRequest: '100m', memoryRequest: '128Mi' };

  const [name, setName] = useState(existingDeployment?.name ?? '');
  const [image, setImage] = useState(initState.image);
  const [ports, setPorts] = useState<PortRow[]>(initState.ports);
  const [volumes, setVolumes] = useState<VolumeRow[]>(initState.volumes);
  const [env, setEnv] = useState<EnvRow[]>(initState.env);
  const [cpuRequest, setCpuRequest] = useState(initState.cpuRequest);
  const [memoryRequest, setMemoryRequest] = useState(initState.memoryRequest);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [issues, setIssues] = useState<readonly CustomDeploymentIssue[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validateState, setValidateState] = useState<'idle' | 'success' | 'warning' | 'error'>('idle');

  const validateMutation = useValidateCustomDeployment(clientId);
  const createMutation = useCreateCustomDeployment(clientId);
  const updateMutation = useUpdateCustomDeployment(clientId);

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
    if (!isEdit && existingNames.includes(name)) return 'name already in use';
    return null;
  })();

  const cpuError = (() => {
    if (!cpuRequest.trim()) return 'required';
    if (!/^\d+(\.\d+)?m?$/.test(cpuRequest)) return 'e.g. 100m, 0.5, 1';
    const n = parseFloat(cpuRequest.replace('m', ''));
    if (isNaN(n) || n <= 0) return 'must be greater than 0';
    return null;
  })();

  const memoryError = (() => {
    if (!memoryRequest.trim()) return 'required';
    if (!/^\d+(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.test(memoryRequest)) return 'e.g. 128Mi, 512Mi, 1Gi';
    if (parseInt(memoryRequest, 10) === 0) return 'must be greater than 0';
    return null;
  })();

  const isPending = isEdit ? updateMutation.isPending : createMutation.isPending;
  const canSubmit = Boolean(name && image && !nameError && !cpuError && !memoryError && !isPending);

  const runValidate = async () => {
    setSubmitError(null);
    try {
      const r = await validateMutation.mutateAsync(buildInput());
      setIssues(r.data.issues);
      const errs = r.data.issues.filter(i => i.severity === 'error').length;
      const warns = r.data.issues.filter(i => i.severity === 'warning').length;
      setValidateState(errs > 0 ? 'error' : warns > 0 ? 'warning' : 'success');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'validation failed');
      setValidateState('error');
    }
  };

  const submit = async () => {
    setSubmitError(null);
    setIssues([]);
    try {
      if (isEdit && existingDeployment) {
        await updateMutation.mutateAsync({
          id: existingDeployment.id,
          image,
          env: env.filter(e => e.name).map(e => ({ name: e.name, value: e.value })),
          ports: ports.filter(p => p.name && p.containerPort > 0),
          resources: { cpuRequest, memoryRequest },
        });
      } else {
        await createMutation.mutateAsync(buildInput());
      }
      onCreated();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : isEdit ? 'update failed' : 'create failed');
    }
  };

  const errorIssues = issues.filter((i) => i.severity === 'error');
  const warningIssues = issues.filter((i) => i.severity === 'warning');

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {isEdit ? `Edit — ${existingDeployment?.name}` : 'Deploy a custom container'}
            </h2>
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
            <Field
              label="Deployment name"
              tooltip="A unique DNS-compatible identifier for your stack. Lowercase letters, digits, and hyphens only; must start and end with an alphanumeric character. Cannot be changed after creation."
            >
              <input
                type="text"
                className={inputCls(Boolean(nameError))}
                value={name}
                onChange={(e) => { if (!isEdit) setName(e.target.value); }}
                placeholder="my-app"
                readOnly={isEdit}
                data-testid="custom-simple-name"
              />
              {nameError && <FieldError>{nameError}</FieldError>}
            </Field>
            <Field
              label="Image"
              tooltip="Docker image reference (e.g. nginx:1.27, ghcr.io/owner/image:tag). Public images work immediately. For private registries, save the deployment first then add a PAT via the registry key button."
            >
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
            <SectionHeader
              title="Ports"
              tooltip="Declare the network ports your container listens on. Each port with 'Service' checked gets a ClusterIP Service, and ports marked 'Ingress' can be selected as the backend target when you add a domain route."
            >
              <button type="button" className={addBtnCls} onClick={() => setPorts([...ports, { containerPort: 0, name: '', protocol: 'TCP', exposeAsService: true, ingressEligible: false }])}>
                <Plus size={14} /> Port
              </button>
            </SectionHeader>
            {ports.length === 0 && <Empty>No ports declared.</Empty>}
            {ports.length > 0 && (
              <div className="mb-1 grid grid-cols-12 gap-2 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <span className="col-span-2 flex items-center gap-0.5">
                  Port <Tooltip text="The port number your container listens on inside the pod (1–65535)." />
                </span>
                <span className="col-span-3 flex items-center gap-0.5">
                  Name <Tooltip text="A short label for this port (e.g. http, grpc, metrics). Used to reference the port in ingress route configuration." />
                </span>
                <span className="col-span-2 flex items-center gap-0.5">
                  Protocol <Tooltip text="Network protocol. TCP covers HTTP/HTTPS and most services. UDP for DNS, media streaming, or game servers. SCTP is rarely needed." />
                </span>
                <span className="col-span-2 flex items-center gap-0.5">
                  Service <Tooltip text="Creates a ClusterIP Service for this port, making it reachable by other pods and the ingress controller within the cluster." />
                </span>
                <span className="col-span-2 flex items-center gap-0.5">
                  Ingress <Tooltip text="Marks this port as eligible to be used as the backend when creating a domain route. Only one port per deployment needs this enabled." />
                </span>
              </div>
            )}
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
            <SectionHeader
              title="Volumes"
              tooltip="Named persistent volumes stored as subdirectories on your tenant PVC. Bind mounts to host paths are not permitted. Data is preserved across pod restarts and redeployments."
            >
              <button type="button" className={addBtnCls} onClick={() => setVolumes([...volumes, { kind: 'volume' as const, name: '', containerPath: '', readOnly: false }])}>
                <Plus size={14} /> Volume
              </button>
            </SectionHeader>
            {volumes.length === 0 && <Empty>No volumes declared.</Empty>}
            {volumes.length > 0 && (
              <div className="mb-1 grid grid-cols-12 gap-2 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <span className="col-span-3 flex items-center gap-0.5">
                  Name <Tooltip text="Volume identifier (e.g. 'data'). Becomes a subdirectory under your tenant storage path — e.g. /storage/my-app/data." />
                </span>
                <span className="col-span-6 flex items-center gap-0.5">
                  Mount path <Tooltip text="Absolute path inside the container where this volume is mounted (e.g. /var/lib/data). The container sees this directory as persistent storage." />
                </span>
                <span className="col-span-2 flex items-center gap-0.5">
                  Read-only <Tooltip text="When checked, the container can read files from this volume but cannot write or delete them. Useful for config files shared across pods." />
                </span>
              </div>
            )}
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
            <SectionHeader
              title="Environment"
              tooltip="Environment variables injected into your container at startup. Values are stored in a Kubernetes Secret in your tenant namespace. Use the PAT modal for registry credentials — avoid putting raw passwords here."
            >
              <button type="button" className={addBtnCls} onClick={() => setEnv([...env, { name: '', value: '' }])}>
                <Plus size={14} /> Env
              </button>
            </SectionHeader>
            {env.length === 0 && <Empty>No env vars declared.</Empty>}
            {env.length > 0 && (
              <div className="mb-1 grid grid-cols-12 gap-2 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <span className="col-span-4 flex items-center gap-0.5">
                  Key <Tooltip text="Environment variable name (e.g. DATABASE_URL, REDIS_HOST). Must be a valid shell identifier — letters, digits, and underscores; conventionally uppercase." />
                </span>
                <span className="col-span-7 flex items-center gap-0.5">
                  Value <Tooltip text="The value assigned to this variable. Visible to anyone with access to your deployment spec. For sensitive values (API keys, passwords), prefer injecting via a separate Secret or the PAT modal." />
                </span>
              </div>
            )}
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
              <Field
                label="CPU request"
                tooltip="Minimum CPU guaranteed to your container. 100m = 0.1 vCPU, 500m = 0.5 vCPU, 1 = 1 full vCPU. Your container may burst above this if the node has spare capacity, but is guaranteed this floor."
              >
                <input type="text" className={inputCls(Boolean(cpuError))} value={cpuRequest} onChange={(e) => setCpuRequest(e.target.value)} />
                {cpuError && <FieldError>{cpuError}</FieldError>}
              </Field>
              <Field
                label="Memory request"
                tooltip="Minimum RAM guaranteed to your container. 128Mi = 128 mebibytes, 512Mi = 512 MiB, 1Gi = 1 GiB. If the container exceeds the cluster memory limit it will be OOM-killed and restarted automatically."
              >
                <input type="text" className={inputCls(Boolean(memoryError))} value={memoryRequest} onChange={(e) => setMemoryRequest(e.target.value)} />
                {memoryError && <FieldError>{memoryError}</FieldError>}
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
          <button
            type="button"
            onClick={runValidate}
            disabled={!image || validateMutation.isPending}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50',
              validateState === 'success' && 'border-green-500 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600 dark:bg-green-900/20 dark:text-green-300',
              validateState === 'warning' && 'border-amber-500 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-300',
              validateState === 'error' && 'border-red-500 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-600 dark:bg-red-900/20 dark:text-red-300',
              validateState === 'idle' && 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
            )}
          >
            {validateMutation.isPending ? (
              <><Loader2 size={14} className="animate-spin" />Validating…</>
            ) : validateState === 'success' ? (
              <><CheckCircle size={14} />Validated</>
            ) : validateState === 'warning' ? (
              <><AlertTriangle size={14} />Warnings</>
            ) : validateState === 'error' ? (
              <><AlertCircle size={14} />Failed</>
            ) : (
              'Validate'
            )}
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="custom-simple-submit">
            {isPending ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save changes' : 'Create')}
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

function Field({ label, tooltip, children }: { label: string; tooltip?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
        {tooltip && <Tooltip text={tooltip} />}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{children}</p>;
}

function SectionHeader({ title, tooltip, children }: { title: string; tooltip: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between">
      <div className="flex items-center gap-1">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{title}</h4>
        <Tooltip text={tooltip} />
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
