// Compose editor — split view with YAML on the left, Issues / Rendered
// preview tabs on the right.
//
// Uses Monaco + monaco-yaml for YAML validation, autocomplete, and
// JSON Schema-driven hints from the backend's compose-schema endpoint.
// Falls back to a plain <textarea> via ErrorBoundary if Monaco fails
// to load (e.g. in low-end environments or during tests).

import { useState, Suspense, lazy, Component, type ReactNode } from 'react';
import { AlertTriangle, FileText, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import { useCreateCustomDeployment, useValidateCustomDeployment, useDeleteCustomDeployment } from '@/hooks/use-custom-deployments';
import { apiFetch } from '@/lib/api-client';
import type { CreateCustomDeploymentComposeInput, CustomDeploymentIssue, CustomDeploymentSpec } from '@k8s-hosting/api-contracts';
import type { CustomDeploymentRow } from '@/hooks/use-custom-deployments';

// Lazy-load Monaco + monaco-yaml (~1.5 MB gzipped). The dynamic import
// is wrapped in a thin component so the ErrorBoundary can catch any
// Monaco init failure and fall back to the textarea.
const MonacoYamlEditor = lazy(() =>
  import('./MonacoYamlEditor').catch(() => ({ default: null as unknown as typeof import('./MonacoYamlEditor').default })),
);

interface EditorFallbackProps {
  value: string;
  onChange: (v: string) => void;
}

function TextareaFallback({ value, onChange }: EditorFallbackProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 resize-none border-0 bg-gray-50 px-4 py-3 font-mono text-xs text-gray-900 outline-none dark:bg-gray-950 dark:text-gray-100"
      spellCheck={false}
      data-testid="custom-compose-textarea"
    />
  );
}

interface ErrorBoundaryState { hasError: boolean }
class EditorErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };
  static getDerivedStateFromError(): ErrorBoundaryState { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

interface Props {
  readonly clientId: string;
  readonly existingNames: readonly string[];
  readonly onClose: () => void;
  readonly onCreated: () => void;
  /** When set, the editor enters edit mode — pre-populated from this row. */
  readonly existingDeployment?: CustomDeploymentRow;
}

const DEFAULT_COMPOSE = `# Compose 3.7-3.9 subset. Documentation: docs/03-features/CUSTOM_CONTAINERS_USER_GUIDE.md
services:
  web:
    image: nginx:1.27
    ports:
      - "80"
    depends_on:
      - api
  api:
    image: ghcr.io/owner/api:v1
    ports:
      - "3000"
    environment:
      DATABASE_URL: postgres://db:5432/app
volumes: {}
`;

type RightTab = 'issues' | 'spec';

export function ComposeEditor({ clientId, existingNames, onClose, onCreated, existingDeployment }: Props) {
  const isEdit = Boolean(existingDeployment);
  const [name, setName] = useState(existingDeployment?.name ?? '');
  // For edit mode we don't have the raw YAML (only the parsed spec is stored).
  // Pre-populate with the spec as JSON-in-YAML comment so the operator can
  // reconstruct the stack, then replace it with a fresh compose file.
  const initYaml = existingDeployment
    ? `# Editing "${existingDeployment.name}" — paste your updated compose.yaml here.\n# Current spec (JSON): ${JSON.stringify(existingDeployment.customSpec, null, 0)}\n\n${DEFAULT_COMPOSE}`
    : DEFAULT_COMPOSE;
  const [yaml, setYaml] = useState(initYaml);
  const [rightTab, setRightTab] = useState<RightTab>('issues');
  const [issues, setIssues] = useState<readonly CustomDeploymentIssue[]>([]);
  const [spec, setSpec] = useState<CustomDeploymentSpec | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jsonSchema, setJsonSchema] = useState<unknown>(null);

  // Fetch the compose JSON Schema from the backend once on mount so
  // Monaco can show per-field validation, autocomplete, and hover docs.
  const loadSchema = async () => {
    try {
      const r = await apiFetch<{ data: unknown }>('/custom-deployments/compose-schema');
      setJsonSchema((r as { data: unknown }).data);
    } catch { /* non-fatal — editor still works without schema */ }
  };
  if (!jsonSchema) { void loadSchema(); }

  const validateMutation = useValidateCustomDeployment(clientId);
  const createMutation = useCreateCustomDeployment(clientId);
  const deleteMutation = useDeleteCustomDeployment(clientId);

  const nameError = (() => {
    if (!name) return null;
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return 'lowercase, DNS-compatible';
    if (!isEdit && existingNames.includes(name)) return 'name already in use';
    return null;
  })();

  const buildInput = (): CreateCustomDeploymentComposeInput => ({
    mode: 'compose',
    name,
    compose_yaml: yaml,
  });

  const runValidate = async () => {
    setSubmitError(null);
    try {
      // Validate without a name (the editor preview path) — backend
      // tolerates missing name in the compose body. We still send
      // `name` if the user typed one so the deploy-name length cap
      // can run.
      const body = buildInput();
      const r = await validateMutation.mutateAsync(body);
      setIssues(r.data.issues);
      setSpec(r.data.spec);
      setRightTab(r.data.ok ? 'spec' : 'issues');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'validation failed');
    }
  };

  const submit = async () => {
    setSubmitError(null);
    try {
      if (isEdit && existingDeployment) {
        // Compose has no partial-patch surface — delete the old deployment and
        // recreate from the new YAML. The name is locked in edit mode so the
        // new record reclaims the same name immediately after deletion.
        await deleteMutation.mutateAsync(existingDeployment.id);
      }
      await createMutation.mutateAsync(buildInput());
      onCreated();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'operation failed');
    }
  };

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const canSubmit = Boolean(name && yaml.trim() && !nameError && errorCount === 0 && !createMutation.isPending && !deleteMutation.isPending);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[90vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <FileText size={18} className="text-gray-500" />
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {isEdit ? `Edit stack — ${existingDeployment?.name}` : 'Compose editor'}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Strict subset of compose 3.7–3.9. Bind mounts are rejected — use named volumes.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </header>

        <div className="flex items-center gap-3 border-b border-gray-200 px-6 py-2 dark:border-gray-700">
          <label className="text-xs font-medium text-gray-700 dark:text-gray-300">Stack name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { if (!isEdit) setName(e.target.value); }}
            readOnly={isEdit}
            className={clsx(
              'w-64 rounded-md border px-2 py-1 font-mono text-sm dark:bg-gray-800 dark:text-gray-100',
              nameError ? 'border-red-300 dark:border-red-700' : 'border-gray-300 dark:border-gray-600',
            )}
            placeholder="my-stack"
            data-testid="custom-compose-name"
          />
          {nameError && <span className="text-xs text-red-600 dark:text-red-400">{nameError}</span>}
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Editor */}
          <div className="flex w-1/2 flex-col border-r border-gray-200 dark:border-gray-700">
            <div className="border-b border-gray-200 px-4 py-1.5 text-xs font-medium text-gray-700 dark:border-gray-700 dark:text-gray-300">
              compose.yaml
            </div>
            <EditorErrorBoundary fallback={<TextareaFallback value={yaml} onChange={setYaml} />}>
              <Suspense fallback={<TextareaFallback value={yaml} onChange={setYaml} />}>
                {MonacoYamlEditor ? (
                  <MonacoYamlEditor
                    value={yaml}
                    onChange={setYaml}
                    jsonSchema={jsonSchema}
                  />
                ) : (
                  <TextareaFallback value={yaml} onChange={setYaml} />
                )}
              </Suspense>
            </EditorErrorBoundary>
          </div>

          {/* Right pane */}
          <div className="flex w-1/2 flex-col">
            <div className="flex items-center gap-4 border-b border-gray-200 px-4 dark:border-gray-700">
              {(['issues', 'spec'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setRightTab(tab)}
                  className={clsx(
                    'border-b-2 px-1 py-2 text-xs font-medium transition-colors',
                    rightTab === tab
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300',
                  )}
                  data-testid={`compose-right-${tab}`}
                >
                  {tab === 'issues' ? `Issues (${errorCount}/${warningCount})` : 'Rendered spec'}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-auto px-4 py-3 text-xs">
              {rightTab === 'issues' && (
                <>
                  {issues.length === 0 && (
                    <p className="italic text-gray-400 dark:text-gray-500">
                      Click <em>Validate</em> to preview parse + validation issues.
                    </p>
                  )}
                  <ul className="space-y-2">
                    {issues.map((iss, i) => (
                      <li key={i} className={clsx(
                        'rounded-md border-l-4 px-3 py-2',
                        iss.severity === 'error' ? 'border-red-500 bg-red-50 dark:bg-red-900/20'
                          : iss.severity === 'warning' ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                            : 'border-gray-300 bg-gray-50 dark:bg-gray-800',
                      )}>
                        <div className="flex items-start gap-2">
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                          <div className="flex-1">
                            <div className="font-mono font-semibold">{iss.code}</div>
                            <div className="text-gray-600 dark:text-gray-300">{iss.message}</div>
                            {iss.path && <div className="mt-0.5 font-mono text-[10px] text-gray-500">{iss.path}</div>}
                            {iss.hint && <div className="mt-0.5 text-gray-500 dark:text-gray-400">↪ {iss.hint}</div>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {rightTab === 'spec' && (
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-gray-700 dark:text-gray-300">
                  {spec ? JSON.stringify(spec, null, 2) : 'Click Validate to preview the normalized spec.'}
                </pre>
              )}
            </div>
          </div>
        </div>

        {submitError && (
          <div className="border-t border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {submitError}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-gray-200 px-6 py-3 dark:border-gray-700">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button type="button" onClick={runValidate} disabled={validateMutation.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
            {validateMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Validate
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="custom-compose-submit">
            {deleteMutation.isPending ? 'Removing old…' : createMutation.isPending ? (isEdit ? 'Recreating…' : 'Creating…') : isEdit ? 'Recreate stack' : 'Deploy stack'}
          </button>
        </footer>
      </div>
    </div>
  );
}
