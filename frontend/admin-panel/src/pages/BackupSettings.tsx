import { useState, lazy, Suspense, type FormEvent } from 'react';
import { HardDrive, Plus, Trash2, TestTube, Loader2, AlertCircle, X, Server, Cloud, Zap, CheckCircle, Edit2, Activity, Gauge } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import BackupHealthBanner from '@/components/BackupHealthBanner';
import BackupHealthTable from '@/components/BackupHealthTable';
import BackupBundlesSection from '@/components/BackupBundlesSection';
import { useBackupHealth } from '@/hooks/use-backup-health';
import {
  useBackupConfigs,
  useCreateBackupConfig,
  useUpdateBackupConfig,
  useDeleteBackupConfig,
  useTestBackupConfig,
  useTestBackupDraft,
  useActivateBackupConfig,
  useDeactivateBackupConfig,
  useBackupList,
  useBackupNow,
  useSpeedtest,
} from '@/hooks/use-backup-config';
import { useRefreshTaskCenter } from '@/hooks/use-task-center';
import { formatBytes } from '@/hooks/use-platform-storage';
import { useTargetSummaries } from '@/hooks/use-snapshot-classes';
import { Link } from 'react-router-dom';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type StorageType = 'ssh' | 's3' | 'cifs';

export default function BackupSettings() {
  const { data: response, isLoading } = useBackupConfigs();
  const { data: healthSummaries, isLoading: healthLoading } = useBackupHealth();
  const { data: summariesData } = useTargetSummaries();
  // Build targetId → assigned classes map once per render. Empty
  // when no classes are routed to a given target — the pill omits.
  const targetSummaries = new Map<string, { snapshotClass: string; priority: number }[]>();
  for (const s of summariesData?.data?.summaries ?? []) {
    targetSummaries.set(s.targetId, s.classes);
  }
  const createConfig = useCreateBackupConfig();
  const updateConfig = useUpdateBackupConfig();
  const deleteConfig = useDeleteBackupConfig();
  const testConfig = useTestBackupConfig();
  const testDraft = useTestBackupDraft();
  const activateConfig = useActivateBackupConfig();
  const deactivateConfig = useDeactivateBackupConfig();
  const [draftResult, setDraftResult] = useState<{
    ok: boolean;
    latencyMs: number;
    error?: { code: string; message: string };
  } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [storageType, setStorageType] = useState<StorageType>('ssh');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Editing mode: when non-null, the form submits a PATCH to this id
  // instead of a POST. Secret fields start blank and are only sent if
  // the operator explicitly types a new value — PATCH omits undefined
  // fields so the existing stored secret is preserved.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [changeSecret, setChangeSecret] = useState(false);
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    latencyMs: number;
    error?: { code: string; message: string };
  } | null>(null);

  const configs = response?.data ?? [];

  // Phase 12.5: SSH targets can use key OR password auth. The form
  // shows whichever the operator picks; the unused field is sent as
  // null on create so the DB row reflects the operator's choice.
  const [sshAuthMethod, setSshAuthMethod] = useState<'key' | 'password'>('key');

  const [form, setForm] = useState({
    name: '',
    ssh_host: '',
    ssh_port: '22',
    ssh_user: '',
    ssh_key: '',
    ssh_password: '',
    ssh_path: '/backups',
    s3_endpoint: '',
    s3_bucket: '',
    s3_region: 'us-east-1',
    s3_access_key: '',
    s3_secret_key: '',
    s3_prefix: '',
    // Path-style addressing — default true (works for Hetzner, Backblaze,
    // R2, Wasabi, MinIO, Garage, Ceph). Operators uncheck for AWS S3.
    s3_use_path_style: true,
    // Phase 9: CIFS form fields.
    cifs_host: '',
    cifs_port: '445',
    cifs_share: '',
    cifs_user: '',
    cifs_password: '',
    cifs_domain: '',
    cifs_path: '',
    retention_days: '30',
    schedule_expression: '0 2 * * *',
  });

  const resetForm = () => {
    setForm({
      name: '', ssh_host: '', ssh_port: '22', ssh_user: '', ssh_key: '', ssh_password: '', ssh_path: '/backups',
      s3_endpoint: '', s3_bucket: '', s3_region: 'us-east-1', s3_access_key: '', s3_secret_key: '',
      s3_prefix: '', s3_use_path_style: true,
      cifs_host: '', cifs_port: '445', cifs_share: '', cifs_user: '', cifs_password: '',
      cifs_domain: '', cifs_path: '',
      retention_days: '30', schedule_expression: '0 2 * * *',
    });
    setShowForm(false);
    setEditingId(null);
    setChangeSecret(false);
    setSshAuthMethod('key');
    setDraftResult(null);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const startEdit = (config: any) => {
    setStorageType(config.storageType);
    setForm({
      name: config.name ?? '',
      ssh_host: config.sshHost ?? '',
      ssh_port: String(config.sshPort ?? 22),
      ssh_user: config.sshUser ?? '',
      ssh_key: '', // always blank — a secret the server never returns
      ssh_password: '', // always blank — a secret the server never returns
      ssh_path: config.sshPath ?? '/backups',
      s3_endpoint: config.s3Endpoint ?? '',
      s3_bucket: config.s3Bucket ?? '',
      s3_region: config.s3Region ?? 'us-east-1',
      s3_access_key: '', // blank; server redacts
      s3_secret_key: '', // blank; server redacts
      s3_prefix: config.s3Prefix ?? '',
      // Server always returns boolean (DB column NOT NULL DEFAULT true).
      // The ?? is belt-and-braces for older clients still on the response
      // schema where this was nullable.
      s3_use_path_style: config.s3UsePathStyle ?? true,
      // Phase 9: CIFS fields.
      cifs_host: config.cifsHost ?? '',
      cifs_port: String(config.cifsPort ?? 445),
      cifs_share: config.cifsShare ?? '',
      cifs_user: config.cifsUser ?? '',
      cifs_password: '', // blank; server never returns
      cifs_domain: config.cifsDomain ?? '',
      cifs_path: config.cifsPath ?? '',
      retention_days: String(config.retentionDays ?? 30),
      schedule_expression: config.scheduleExpression ?? '0 2 * * *',
    });
    setEditingId(config.id);
    setChangeSecret(false);
    // Restore SSH auth method from the existing config — the API
    // returns booleans `hasSshKey` / `hasSshPassword` (never the
    // secrets themselves). If neither is set yet, default to 'key'.
    if (config.storageType === 'ssh') {
      setSshAuthMethod(config.hasSshPassword && !config.hasSshKey ? 'password' : 'key');
    }
    setShowForm(true);
    setDraftResult(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const buildInput = () => {
    const base = {
      name: form.name,
      retention_days: Number(form.retention_days),
      schedule_expression: form.schedule_expression,
      enabled: true,
    };
    if (storageType === 'ssh') {
      // Phase 12.5: send whichever auth method the operator picked;
      // the other field stays undefined so the backend stores NULL.
      return {
        ...base,
        storage_type: 'ssh' as const,
        ssh_host: form.ssh_host,
        ssh_port: Number(form.ssh_port),
        ssh_user: form.ssh_user,
        ssh_path: form.ssh_path,
        ...(sshAuthMethod === 'key' ? { ssh_key: form.ssh_key } : { ssh_password: form.ssh_password }),
      };
    }
    if (storageType === 'cifs') {
      return {
        ...base,
        storage_type: 'cifs' as const,
        cifs_host: form.cifs_host,
        cifs_port: Number(form.cifs_port),
        cifs_share: form.cifs_share,
        cifs_user: form.cifs_user,
        cifs_password: form.cifs_password,
        cifs_domain: form.cifs_domain || undefined,
        cifs_path: form.cifs_path || undefined,
      };
    }
    return { ...base, storage_type: 's3' as const, s3_endpoint: form.s3_endpoint, s3_bucket: form.s3_bucket, s3_region: form.s3_region, s3_access_key: form.s3_access_key, s3_secret_key: form.s3_secret_key, s3_prefix: form.s3_prefix || undefined, s3_use_path_style: form.s3_use_path_style };
  };

  // PATCH payload for edit mode. Strictly omits secrets unless the
  // operator toggled "Change secret". The backend's
  // updateBackupConfigSchema is partial + service.ts uses
  // `if (input.field !== undefined)` on each field, so omitted fields
  // preserve the existing stored value.
  const buildPatchInput = () => {
    const payload: Record<string, unknown> = {
      name: form.name,
      retention_days: Number(form.retention_days),
      schedule_expression: form.schedule_expression,
    };
    if (storageType === 'ssh') {
      payload.ssh_host = form.ssh_host;
      payload.ssh_port = Number(form.ssh_port);
      payload.ssh_user = form.ssh_user;
      payload.ssh_path = form.ssh_path;
      // Phase 12.5: when changing the secret, send whichever auth
      // method the operator has selected. The OTHER field is sent
      // explicitly as empty string so the backend can clear the
      // unused credential (key↔password switch).
      if (changeSecret) {
        if (sshAuthMethod === 'key' && form.ssh_key.trim().length > 0) {
          payload.ssh_key = form.ssh_key;
          payload.ssh_password = '';
        } else if (sshAuthMethod === 'password' && form.ssh_password.trim().length > 0) {
          payload.ssh_password = form.ssh_password;
          payload.ssh_key = '';
        }
      }
    } else {
      payload.s3_endpoint = form.s3_endpoint;
      payload.s3_bucket = form.s3_bucket;
      payload.s3_region = form.s3_region;
      payload.s3_prefix = form.s3_prefix || undefined;
      payload.s3_use_path_style = form.s3_use_path_style;
      if (changeSecret && form.s3_access_key.trim().length > 0) {
        payload.s3_access_key = form.s3_access_key;
      }
      if (changeSecret && form.s3_secret_key.trim().length > 0) {
        payload.s3_secret_key = form.s3_secret_key;
      }
    }
    return payload;
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateConfig.mutateAsync({ id: editingId, input: buildPatchInput() });
      } else {
        await createConfig.mutateAsync(buildInput());
      }
      resetForm();
    } catch { /* error shown below */ }
  };

  const handleDraftTest = async () => {
    setDraftResult(null);
    try {
      const result = await testDraft.mutateAsync(buildInput());
      setDraftResult(result.data);
    } catch (err) {
      setDraftResult({
        ok: false,
        latencyMs: 0,
        error: {
          code: 'CLIENT_ERROR',
          message: err instanceof Error ? err.message : 'Request failed',
        },
      });
    }
  };

  const handleTest = async (id: string) => {
    try {
      const result = await testConfig.mutateAsync(id);
      setTestResult({ id, ...result.data });
    } catch {
      setTestResult({
        id,
        ok: false,
        latencyMs: 0,
        error: { code: 'CLIENT_ERROR', message: 'Connection test failed' },
      });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteConfig.mutateAsync(id);
      setDeleteConfirmId(null);
    } catch { /* error available */ }
  };

  return (
    <div className="space-y-6">
      {/* DR Job Health banner — only renders when a DR cron is failing */}
      <BackupHealthBanner summaries={healthSummaries} />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HardDrive size={28} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="backup-settings-heading">Backup Configuration</h1>
        </div>
        <button
          type="button"
          onClick={() => { if (showForm) { resetForm(); } else { setShowForm(true); } }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          data-testid="add-backup-config-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Backup Target'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="backup-config-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bc-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
              <input id="bc-name" className={INPUT_CLASS + ' mt-1'} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="bc-name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Storage Type</label>
              <div className="mt-1 flex gap-2">
                <button type="button" onClick={() => setStorageType('ssh')} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border ${storageType === 'ssh' ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`} data-testid="bc-type-ssh">
                  <Server size={14} /> SSH
                </button>
                <button type="button" onClick={() => setStorageType('s3')} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border ${storageType === 's3' ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`} data-testid="bc-type-s3">
                  <Cloud size={14} /> S3
                </button>
                <button type="button" onClick={() => setStorageType('cifs')} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium border ${storageType === 'cifs' ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`} data-testid="bc-type-cifs">
                  <HardDrive size={14} /> CIFS/SMB
                </button>
              </div>
            </div>
          </div>

          {storageType === 'ssh' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="bc-ssh-host" className="block text-sm font-medium text-gray-700 dark:text-gray-300">SSH Host</label>
                <input id="bc-ssh-host" className={INPUT_CLASS + ' mt-1'} value={form.ssh_host} onChange={(e) => setForm({ ...form, ssh_host: e.target.value })} required data-testid="bc-ssh-host" />
              </div>
              <div>
                <label htmlFor="bc-ssh-port" className="block text-sm font-medium text-gray-700 dark:text-gray-300">SSH Port</label>
                <input id="bc-ssh-port" type="number" className={INPUT_CLASS + ' mt-1'} value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: e.target.value })} data-testid="bc-ssh-port" />
              </div>
              <div>
                <label htmlFor="bc-ssh-user" className="block text-sm font-medium text-gray-700 dark:text-gray-300">SSH User</label>
                <input id="bc-ssh-user" className={INPUT_CLASS + ' mt-1'} value={form.ssh_user} onChange={(e) => setForm({ ...form, ssh_user: e.target.value })} required data-testid="bc-ssh-user" />
              </div>
              <div>
                <label htmlFor="bc-ssh-path" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Remote Path</label>
                <input id="bc-ssh-path" className={INPUT_CLASS + ' mt-1'} value={form.ssh_path} onChange={(e) => setForm({ ...form, ssh_path: e.target.value })} required data-testid="bc-ssh-path" />
              </div>
              {/* Phase 12.5: SSH auth method radio. Switching toggles
                  the key/password field below. */}
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Authentication</label>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSshAuthMethod('key')}
                    className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium border ${sshAuthMethod === 'key' ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}
                    data-testid="bc-ssh-auth-key"
                  >
                    SSH key
                  </button>
                  <button
                    type="button"
                    onClick={() => setSshAuthMethod('password')}
                    className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium border ${sshAuthMethod === 'password' ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}
                    data-testid="bc-ssh-auth-password"
                  >
                    Password
                  </button>
                </div>
              </div>
              {sshAuthMethod === 'key' && (
                <div className="sm:col-span-2">
                  <label htmlFor="bc-ssh-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    SSH Private Key
                    {editingId && (
                      <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(leave blank to keep current)</span>
                    )}
                  </label>
                  <textarea
                    id="bc-ssh-key"
                    rows={4}
                    className={INPUT_CLASS + ' mt-1 font-mono text-xs disabled:opacity-50'}
                    value={form.ssh_key}
                    onChange={(e) => setForm({ ...form, ssh_key: e.target.value })}
                    required={!editingId}
                    disabled={!!editingId && !changeSecret}
                    placeholder={editingId ? '(unchanged)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                    data-testid="bc-ssh-key"
                  />
                </div>
              )}
              {sshAuthMethod === 'password' && (
                <div className="sm:col-span-2">
                  <label htmlFor="bc-ssh-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    SSH Password
                    {editingId && (
                      <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(leave blank to keep current)</span>
                    )}
                  </label>
                  <input
                    id="bc-ssh-password"
                    type="password"
                    autoComplete="new-password"
                    className={INPUT_CLASS + ' mt-1 disabled:opacity-50'}
                    value={form.ssh_password}
                    onChange={(e) => setForm({ ...form, ssh_password: e.target.value })}
                    required={!editingId}
                    disabled={!!editingId && !changeSecret}
                    placeholder={editingId ? '(unchanged)' : '••••••••'}
                    data-testid="bc-ssh-password"
                  />
                </div>
              )}
            </div>
          )}

          {storageType === 's3' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="bc-s3-endpoint" className="block text-sm font-medium text-gray-700 dark:text-gray-300">S3 Endpoint</label>
                <input id="bc-s3-endpoint" className={INPUT_CLASS + ' mt-1'} placeholder="https://s3.amazonaws.com" value={form.s3_endpoint} onChange={(e) => setForm({ ...form, s3_endpoint: e.target.value })} required data-testid="bc-s3-endpoint" />
              </div>
              <div>
                <label htmlFor="bc-s3-bucket" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Bucket</label>
                <input id="bc-s3-bucket" className={INPUT_CLASS + ' mt-1'} value={form.s3_bucket} onChange={(e) => setForm({ ...form, s3_bucket: e.target.value })} required data-testid="bc-s3-bucket" />
              </div>
              <div>
                <label htmlFor="bc-s3-region" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Region</label>
                <input id="bc-s3-region" className={INPUT_CLASS + ' mt-1'} value={form.s3_region} onChange={(e) => setForm({ ...form, s3_region: e.target.value })} required data-testid="bc-s3-region" />
              </div>
              <div>
                <label htmlFor="bc-s3-prefix" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Prefix <span className="text-xs text-gray-400">(optional)</span></label>
                <input id="bc-s3-prefix" className={INPUT_CLASS + ' mt-1'} value={form.s3_prefix} onChange={(e) => setForm({ ...form, s3_prefix: e.target.value })} data-testid="bc-s3-prefix" />
              </div>
              <div className="flex items-start gap-2">
                <input
                  id="bc-s3-use-path-style"
                  type="checkbox"
                  className="mt-1"
                  checked={form.s3_use_path_style}
                  onChange={(e) => setForm({ ...form, s3_use_path_style: e.target.checked })}
                  data-testid="bc-s3-use-path-style"
                />
                <label htmlFor="bc-s3-use-path-style" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Use path-style URLs
                  <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                    Default for Hetzner, Backblaze B2, Cloudflare R2, Wasabi, MinIO, Garage. Uncheck for AWS S3 with virtual-hosted addressing.
                  </span>
                </label>
              </div>
              <div>
                <label htmlFor="bc-s3-access" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Access Key
                  {editingId && (
                    <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(leave blank to keep)</span>
                  )}
                </label>
                <input
                  id="bc-s3-access"
                  className={INPUT_CLASS + ' mt-1 font-mono disabled:opacity-50'}
                  value={form.s3_access_key}
                  onChange={(e) => setForm({ ...form, s3_access_key: e.target.value })}
                  required={!editingId}
                  disabled={!!editingId && !changeSecret}
                  placeholder={editingId ? '(unchanged)' : undefined}
                  data-testid="bc-s3-access"
                />
              </div>
              <div>
                <label htmlFor="bc-s3-secret" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Secret Key
                  {editingId && (
                    <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(leave blank to keep)</span>
                  )}
                </label>
                <input
                  id="bc-s3-secret"
                  type="password"
                  className={INPUT_CLASS + ' mt-1 font-mono disabled:opacity-50'}
                  value={form.s3_secret_key}
                  onChange={(e) => setForm({ ...form, s3_secret_key: e.target.value })}
                  required={!editingId}
                  disabled={!!editingId && !changeSecret}
                  placeholder={editingId ? '(unchanged)' : undefined}
                  data-testid="bc-s3-secret"
                />
              </div>
              {editingId && (
                <div className="sm:col-span-2">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={changeSecret}
                      onChange={(e) => setChangeSecret(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                      data-testid="bc-change-secret"
                    />
                    Change S3 access/secret keys
                  </label>
                </div>
              )}
            </div>
          )}

          {storageType === 'cifs' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="bc-cifs-host" className="block text-sm font-medium text-gray-700 dark:text-gray-300">SMB Host</label>
                <input id="bc-cifs-host" className={INPUT_CLASS + ' mt-1'} placeholder="storage.example.com or 10.0.0.5" value={form.cifs_host} onChange={(e) => setForm({ ...form, cifs_host: e.target.value })} required data-testid="bc-cifs-host" />
              </div>
              <div>
                <label htmlFor="bc-cifs-port" className="block text-sm font-medium text-gray-700 dark:text-gray-300">SMB Port</label>
                <input id="bc-cifs-port" type="number" className={INPUT_CLASS + ' mt-1'} value={form.cifs_port} onChange={(e) => setForm({ ...form, cifs_port: e.target.value })} data-testid="bc-cifs-port" />
              </div>
              <div>
                <label htmlFor="bc-cifs-share" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Share</label>
                <input id="bc-cifs-share" className={INPUT_CLASS + ' mt-1'} placeholder="backups" value={form.cifs_share} onChange={(e) => setForm({ ...form, cifs_share: e.target.value })} required data-testid="bc-cifs-share" />
              </div>
              <div>
                <label htmlFor="bc-cifs-domain" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Domain <span className="text-xs text-gray-400">(optional, AD)</span></label>
                <input id="bc-cifs-domain" className={INPUT_CLASS + ' mt-1'} value={form.cifs_domain} onChange={(e) => setForm({ ...form, cifs_domain: e.target.value })} data-testid="bc-cifs-domain" />
              </div>
              <div>
                <label htmlFor="bc-cifs-user" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Username</label>
                <input id="bc-cifs-user" className={INPUT_CLASS + ' mt-1'} value={form.cifs_user} onChange={(e) => setForm({ ...form, cifs_user: e.target.value })} required data-testid="bc-cifs-user" />
              </div>
              <div>
                <label htmlFor="bc-cifs-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Password
                  {editingId && (
                    <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(leave blank to keep)</span>
                  )}
                </label>
                <input
                  id="bc-cifs-password"
                  type="password"
                  className={INPUT_CLASS + ' mt-1 font-mono disabled:opacity-50'}
                  value={form.cifs_password}
                  onChange={(e) => setForm({ ...form, cifs_password: e.target.value })}
                  required={!editingId}
                  disabled={!!editingId && !changeSecret}
                  placeholder={editingId ? '(unchanged)' : undefined}
                  data-testid="bc-cifs-password"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="bc-cifs-path" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Sub-path <span className="text-xs text-gray-400">(optional, within share)</span></label>
                <input id="bc-cifs-path" className={INPUT_CLASS + ' mt-1'} placeholder="/cluster1/backups" value={form.cifs_path} onChange={(e) => setForm({ ...form, cifs_path: e.target.value })} data-testid="bc-cifs-path" />
              </div>
              {editingId && (
                <div className="sm:col-span-2">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={changeSecret}
                      onChange={(e) => setChangeSecret(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                      data-testid="bc-change-cifs-password"
                    />
                    Change SMB password
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bc-retention" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Retention (days)</label>
              <input id="bc-retention" type="number" className={INPUT_CLASS + ' mt-1'} value={form.retention_days} onChange={(e) => setForm({ ...form, retention_days: e.target.value })} data-testid="bc-retention" />
            </div>
            <div>
              <label htmlFor="bc-schedule" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Schedule (cron)</label>
              <input id="bc-schedule" className={INPUT_CLASS + ' mt-1 font-mono'} value={form.schedule_expression} onChange={(e) => setForm({ ...form, schedule_expression: e.target.value })} data-testid="bc-schedule" />
            </div>
          </div>

          {createConfig.error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{createConfig.error instanceof Error ? createConfig.error.message : 'Failed to create'}</div>
          )}
          {draftResult && (
            <div
              className={`flex items-center gap-2 text-sm ${draftResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
              data-testid="bc-draft-result"
            >
              {draftResult.ok
                ? <><CheckCircle size={14} /> Connection test passed ({draftResult.latencyMs}ms)</>
                : <><AlertCircle size={14} /> {draftResult.error?.code ?? 'ERROR'}: {draftResult.error?.message ?? 'Test failed'}</>}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleDraftTest}
              disabled={testDraft.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
              data-testid="bc-test-draft"
            >
              {testDraft.isPending ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
              Test Connection
            </button>
            <button
              type="submit"
              disabled={createConfig.isPending || updateConfig.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="bc-submit"
            >
              {(createConfig.isPending || updateConfig.isPending) && <Loader2 size={14} className="animate-spin" />}
              {editingId ? 'Save Changes' : 'Create Backup Target'}
            </button>
          </div>
        </form>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>
      )}

      {!isLoading && configs.length === 0 && !showForm && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-12 text-center shadow-sm">
          <HardDrive size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No backup targets configured. Add one to get started.</p>
        </div>
      )}

      {!isLoading && configs.length > 0 && (
        <div className="space-y-3">
          {configs.map((config) => (
            <div key={config.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid={`backup-config-${config.id}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {config.storageType === 'ssh' && <Server size={18} className="text-gray-500 dark:text-gray-400" />}
                  {config.storageType === 's3' && <Cloud size={18} className="text-blue-500 dark:text-blue-400" />}
                  {config.storageType === 'cifs' && <HardDrive size={18} className="text-purple-500 dark:text-purple-400" />}
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-gray-100">{config.name}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {config.storageType === 'ssh' && `${config.sshUser}@${config.sshHost}:${config.sshPath}`}
                      {config.storageType === 's3' && `s3://${config.s3Bucket}${config.s3Prefix ? '/' + config.s3Prefix : ''}`}
                      {config.storageType === 'cifs' && `smb://${config.cifsUser}@${config.cifsHost}/${config.cifsShare}${config.cifsPath ?? ''}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {config.active && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300" data-testid={`active-badge-${config.id}`}>
                      <Zap size={11} /> Active
                    </span>
                  )}
                  <StatusBadge status={config.enabled ? 'active' : 'suspended'} label={config.enabled ? 'Enabled' : 'Disabled'} />
                  {config.lastTestStatus && (
                    <StatusBadge status={config.lastTestStatus === 'ok' ? 'active' : 'error'} label={config.lastTestStatus} />
                  )}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                <span>Retention: {config.retentionDays}d</span>
                <span>Schedule: {config.scheduleExpression}</span>
                {config.lastTestedAt && <span>Last tested: {new Date(config.lastTestedAt).toLocaleString()}</span>}
              </div>
              {/* Snapshot-class "Used by" pill — operator can see at a glance
                  which classes route to this target. Click-through to the
                  assignments page lets them reassign before deletion. */}
              {(() => {
                const usedBy = targetSummaries.get(config.id) ?? [];
                if (usedBy.length === 0) {
                  return (
                    <div className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
                      <span className="rounded bg-gray-100 dark:bg-gray-900/40 px-2 py-0.5">
                        Not assigned to any snapshot class
                      </span>
                    </div>
                  );
                }
                return (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-gray-500 dark:text-gray-400">Used by:</span>
                    {usedBy.map((c) => (
                      <Link
                        key={c.snapshotClass}
                        to="/settings/backup-classes"
                        className="rounded bg-indigo-100 dark:bg-indigo-900/40 px-2 py-0.5 font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-900/60"
                        title={`priority ${c.priority}`}
                      >
                        {c.snapshotClass}
                        {c.priority !== 100 && <span className="ml-1 text-indigo-500 dark:text-indigo-400">·p{c.priority}</span>}
                      </Link>
                    ))}
                  </div>
                );
              })()}
              {testResult?.id === config.id && (
                <div className={`mt-2 text-xs ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  Test: {testResult.ok ? 'ok' : 'error'} ({testResult.latencyMs}ms){testResult.error ? ` — ${testResult.error.message}` : ''}
                </div>
              )}
              {/* Phase 10 — last speedtest result inline. NULL until first run. */}
              <SpeedtestResultRow config={config} />
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => handleTest(config.id)} disabled={testConfig.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`test-backup-${config.id}`}>
                  <TestTube size={12} /> Test Connection
                </button>
                <SpeedtestButton configId={config.id} configName={config.name} />
                <button
                  type="button"
                  onClick={() => startEdit(config)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  data-testid={`edit-backup-${config.id}`}
                >
                  <Edit2 size={12} /> Edit
                </button>
                {config.storageType === 's3' && (
                  config.active ? (
                    <button
                      type="button"
                      onClick={() => deactivateConfig.mutate(config.id)}
                      disabled={deactivateConfig.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 dark:border-amber-800 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
                      data-testid={`deactivate-backup-${config.id}`}
                    >
                      {deactivateConfig.isPending ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => activateConfig.mutate(config.id)}
                      disabled={activateConfig.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 dark:border-green-800 px-3 py-1.5 text-xs font-medium text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50"
                      data-testid={`activate-backup-${config.id}`}
                    >
                      {activateConfig.isPending ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                      Activate
                    </button>
                  )
                )}
                {deleteConfirmId === config.id ? (
                  <div className="flex gap-1">
                    <button type="button" onClick={() => handleDelete(config.id)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button>
                    <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(config.id)}
                    disabled={config.active}
                    title={config.active ? 'Deactivate before deleting' : undefined}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid={`delete-backup-${config.id}`}
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                )}
                {activateConfig.error && (
                  <span className="text-xs text-red-600 dark:text-red-400 w-full">
                    Activate failed: {activateConfig.error instanceof Error ? activateConfig.error.message : 'unknown error'}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <RecentBackupsPanel activeConfigId={configs.find((c) => c.active)?.id ?? null} />

      {/* Tenant bundles (tenant-bundles / ADR-032) — component-oriented
          off-site backups. Distinct from Longhorn-target Recent Backups
          above (those are PVC-level Longhorn snapshots). */}
      <BackupBundlesSection configs={configs} />

      {/* DR Job Health table — discovers Jobs cluster-wide via labels.
          Adding a new backup job (with the
          platform.phoenix-host.net/backup-health-watch=true label) is a
          pure YAML change — no UI update needed. */}
      <section data-testid="backup-health-section">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            DR Job Health
          </h2>
        </div>
        <BackupHealthTable summaries={healthSummaries} isLoading={healthLoading} />
      </section>
    </div>
  );
}

/**
 * Shows the 10 most recent Longhorn Backups tied to the active backup
 * target + a "Backup Now" button that triggers an on-demand backup on
 * every PVC opted into the default recurring-job group. The list polls
 * every 30s so a Backup Now click surfaces its artifacts automatically.
 */
function RecentBackupsPanel({ activeConfigId }: { activeConfigId: string | null }) {
  const { data: backupsResp, isLoading } = useBackupList(activeConfigId);
  const triggerNow = useBackupNow(activeConfigId ?? '');
  const [lastResult, setLastResult] = useState<{ ok: boolean; message: string } | null>(null);

  const backups = (backupsResp?.data ?? []).slice(0, 10);

  if (!activeConfigId) {
    return null;
  }

  const handleBackupNow = async () => {
    setLastResult(null);
    try {
      const res = await triggerNow.mutateAsync();
      setLastResult({ ok: true, message: res.data.message });
    } catch (err) {
      setLastResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Trigger failed',
      });
    }
  };

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
      data-testid="recent-backups-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <HardDrive size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Backups</h2>
        </div>
        <button
          type="button"
          onClick={handleBackupNow}
          disabled={triggerNow.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="backup-now-btn"
        >
          {triggerNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
          Backup Now
        </button>
      </div>

      {lastResult && (
        <div
          className={`mt-3 text-xs ${lastResult.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}
          data-testid="backup-now-result"
        >
          {lastResult.message}
        </div>
      )}

      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading backups…
          </div>
        ) : backups.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="no-backups">
            No backups yet. Click Backup Now or wait for the next daily RecurringJob (02:00 UTC).
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="backups-table">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className="pb-2">Name</th>
                <th className="pb-2">Volume</th>
                <th className="pb-2">Size</th>
                <th className="pb-2">State</th>
                <th className="pb-2">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {backups.map((b) => (
                <tr key={b.name} className="text-gray-900 dark:text-gray-100" data-testid={`backup-row-${b.name}`}>
                  <td className="py-2 font-mono text-xs truncate max-w-[280px]" title={b.name}>{b.name}</td>
                  <td className="py-2 font-mono text-xs truncate max-w-[180px]" title={b.volumeName}>{b.volumeName}</td>
                  <td className="py-2">{formatBytes(Number(b.size) || 0)}</td>
                  <td className="py-2">
                    <StatusBadge
                      status={b.state === 'Completed' ? 'active' : b.state === 'Error' ? 'error' : 'pending'}
                      label={b.state}
                    />
                  </td>
                  <td className="py-2 text-xs text-gray-500 dark:text-gray-400">
                    {b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Phase 10: Speedtest button + result row ─────────────────────────
//
// SpeedtestButton kicks off the rclone Job AND proactively opens the
// SpeedtestProgressModal so the operator sees live progress instead of
// just a spinning button. The modal polls /me/tasks + /admin/backup-configs
// directly so the moment the backend's start phase logs `operationId`
// + `taskId` (returned synchronously from POST), the polling locks on.

const SpeedtestProgressModalLazy = lazy(() => import('@/components/SpeedtestProgressModal'));

function SpeedtestButton({ configId, configName }: { readonly configId: string; readonly configName: string }) {
  const mutation = useSpeedtest();
  const refreshTasks = useRefreshTaskCenter();
  const [modalState, setModalState] = useState<{
    targetId: string;
    targetName: string;
    payloadBytes: number;
    // Filled in when the POST returns with the operationId. While null,
    // the modal shows a "Starting…" placeholder and polls /me/tasks
    // for the latest backup.speedtest task on this target.
    operationId: string | null;
  } | null>(null);

  const handleClick = () => {
    if (!window.confirm(
      `Run speedtest on "${configName}"?\n\n` +
      `Uploads 100 MB random data to the target, then downloads it back. ` +
      `Takes 10-60 seconds depending on link speed.`,
    )) return;

    // Open the modal IMMEDIATELY — no awaiting the POST. The modal
    // polls /me/tasks for the latest backup.speedtest task on this
    // target so progress is visible from the moment the Job is
    // scheduled. When the POST eventually returns, we patch the
    // modal's operationId in so polling pins to the exact task.
    setModalState({
      targetId: configId,
      targetName: configName,
      payloadBytes: 100 * 1024 * 1024,
      operationId: null,
    });
    refreshTasks();

    // Fire-and-forget the POST. Errors persist server-side as
    // last_speedtest_error; the modal renders them.
    mutation.mutate({ configId }, {
      onSuccess: (result) => {
        refreshTasks();
        if (result?.data?.operationId) {
          setModalState((prev) => prev ? { ...prev, operationId: result.data.operationId! } : prev);
        }
      },
      onError: () => {
        refreshTasks();
      },
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={mutation.isPending}
        className="inline-flex items-center gap-2 rounded-lg border-2 border-purple-300 dark:border-purple-600 bg-purple-50 dark:bg-purple-900/30 px-4 py-2 text-sm font-semibold text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/50 disabled:opacity-50 shadow-sm"
        data-testid={`speedtest-${configId}`}
        title="Upload + download a 100 MB test payload to measure throughput"
      >
        {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Gauge size={14} />}
        {mutation.isPending ? 'Running speedtest…' : 'Run Speedtest'}
      </button>
      {modalState && (
        <Suspense fallback={null}>
          <SpeedtestProgressModalLazy
            operationId={modalState.operationId ?? ''}
            targetId={modalState.targetId}
            targetName={modalState.targetName}
            payloadBytes={modalState.payloadBytes}
            onClose={() => {
              setModalState(null);
              refreshTasks();
            }}
          />
        </Suspense>
      )}
    </>
  );
}

interface SpeedtestResultConfig {
  readonly lastSpeedtestAt: string | null;
  readonly lastSpeedtestUploadMbps: number | null;
  readonly lastSpeedtestDownloadMbps: number | null;
  readonly lastSpeedtestLatencyMs: number | null;
  readonly lastSpeedtestPayloadBytes: number | null;
  readonly lastSpeedtestError: string | null;
}

function SpeedtestResultRow({ config }: { readonly config: SpeedtestResultConfig }) {
  // Phase 12.5 / discoverability: render an empty-state hint when no
  // speedtest has run yet — operators were missing the action button
  // when there was no result row to anchor it visually.
  if (!config.lastSpeedtestAt) {
    return (
      <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400">
        <Gauge size={12} />
        <span>No speedtest yet — click <strong>Run Speedtest</strong> below to measure throughput.</span>
      </div>
    );
  }
  const when = new Date(config.lastSpeedtestAt);
  const ageHours = (Date.now() - when.getTime()) / 3_600_000;
  const stale = ageHours > 24 * 7; // > 1 week
  if (config.lastSpeedtestError) {
    return (
      <div className="mt-2 flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50/50 dark:bg-rose-900/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
        <AlertCircle size={14} className="mt-0.5 flex-none" />
        <div>
          <div className="font-medium">Last speedtest failed</div>
          <div className="text-rose-600 dark:text-rose-400">{config.lastSpeedtestError}</div>
          <div className="mt-0.5 text-rose-500 dark:text-rose-500">{when.toLocaleString()}</div>
        </div>
      </div>
    );
  }
  const up = config.lastSpeedtestUploadMbps;
  const down = config.lastSpeedtestDownloadMbps;
  const lat = config.lastSpeedtestLatencyMs;
  const fmtMbps = (m: number | null) => m !== null ? `${m.toFixed(1)} Mbps` : '—';
  return (
    <div className={`mt-2 inline-flex items-center gap-3 rounded-lg border px-3 py-1.5 text-xs ${stale ? 'border-amber-200 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-300' : 'border-purple-200 dark:border-purple-700 bg-purple-50/50 dark:bg-purple-900/10 text-purple-700 dark:text-purple-300'}`}>
      <Gauge size={12} />
      <span className="font-medium">Speedtest:</span>
      <span title="Upload">↑ {fmtMbps(up)}</span>
      <span title="Download">↓ {fmtMbps(down)}</span>
      <span title="Latency">{lat !== null ? `${lat}ms` : '—'} latency</span>
      <span className="text-purple-500 dark:text-purple-500">
        {stale ? '(stale, > 1 week) · ' : ''}{when.toLocaleString()}
      </span>
    </div>
  );
}
