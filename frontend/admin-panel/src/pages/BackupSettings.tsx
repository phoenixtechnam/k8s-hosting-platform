import { useState, type FormEvent } from 'react';
import { HardDrive, Plus, Trash2, TestTube, Loader2, AlertCircle, X, Server, Cloud } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import {
  useBackupConfigs,
  useCreateBackupConfig,
  useDeleteBackupConfig,
  useTestBackupConfig,
} from '@/hooks/use-backup-config';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type StorageType = 'ssh' | 's3';

export default function BackupSettings() {
  const { data: response, isLoading } = useBackupConfigs();
  const createConfig = useCreateBackupConfig();
  const deleteConfig = useDeleteBackupConfig();
  const testConfig = useTestBackupConfig();
  const [showForm, setShowForm] = useState(false);
  const [storageType, setStorageType] = useState<StorageType>('ssh');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    latencyMs: number;
    error?: { code: string; message: string };
  } | null>(null);

  const configs = response?.data ?? [];

  const [form, setForm] = useState({
    name: '',
    ssh_host: '',
    ssh_port: '22',
    ssh_user: '',
    ssh_key: '',
    ssh_path: '/backups',
    s3_endpoint: '',
    s3_bucket: '',
    s3_region: 'us-east-1',
    s3_access_key: '',
    s3_secret_key: '',
    s3_prefix: '',
    retention_days: '30',
    schedule_expression: '0 2 * * *',
  });

  const resetForm = () => {
    setForm({
      name: '', ssh_host: '', ssh_port: '22', ssh_user: '', ssh_key: '', ssh_path: '/backups',
      s3_endpoint: '', s3_bucket: '', s3_region: 'us-east-1', s3_access_key: '', s3_secret_key: '',
      s3_prefix: '', retention_days: '30', schedule_expression: '0 2 * * *',
    });
    setShowForm(false);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const base = {
      name: form.name,
      retention_days: Number(form.retention_days),
      schedule_expression: form.schedule_expression,
      enabled: true,
    };

    const input = storageType === 'ssh'
      ? { ...base, storage_type: 'ssh' as const, ssh_host: form.ssh_host, ssh_port: Number(form.ssh_port), ssh_user: form.ssh_user, ssh_key: form.ssh_key, ssh_path: form.ssh_path }
      : { ...base, storage_type: 's3' as const, s3_endpoint: form.s3_endpoint, s3_bucket: form.s3_bucket, s3_region: form.s3_region, s3_access_key: form.s3_access_key, s3_secret_key: form.s3_secret_key, s3_prefix: form.s3_prefix || undefined };

    try {
      await createConfig.mutateAsync(input);
      resetForm();
    } catch { /* error shown below */ }
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HardDrive size={28} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="backup-settings-heading">Backup Configuration</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((p) => !p)}
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
              <div className="sm:col-span-2">
                <label htmlFor="bc-ssh-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">SSH Private Key</label>
                <textarea id="bc-ssh-key" rows={4} className={INPUT_CLASS + ' mt-1 font-mono text-xs'} value={form.ssh_key} onChange={(e) => setForm({ ...form, ssh_key: e.target.value })} required placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" data-testid="bc-ssh-key" />
              </div>
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
              <div>
                <label htmlFor="bc-s3-access" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Access Key</label>
                <input id="bc-s3-access" className={INPUT_CLASS + ' mt-1 font-mono'} value={form.s3_access_key} onChange={(e) => setForm({ ...form, s3_access_key: e.target.value })} required data-testid="bc-s3-access" />
              </div>
              <div>
                <label htmlFor="bc-s3-secret" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Secret Key</label>
                <input id="bc-s3-secret" className={INPUT_CLASS + ' mt-1 font-mono'} value={form.s3_secret_key} onChange={(e) => setForm({ ...form, s3_secret_key: e.target.value })} required data-testid="bc-s3-secret" />
              </div>
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

          <div className="flex justify-end">
            <button type="submit" disabled={createConfig.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="bc-submit">
              {createConfig.isPending && <Loader2 size={14} className="animate-spin" />}
              Create Backup Target
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
                  {config.storageType === 'ssh' ? <Server size={18} className="text-gray-500 dark:text-gray-400" /> : <Cloud size={18} className="text-blue-500 dark:text-blue-400" />}
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-gray-100">{config.name}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {config.storageType === 'ssh'
                        ? `${config.sshUser}@${config.sshHost}:${config.sshPath}`
                        : `s3://${config.s3Bucket}${config.s3Prefix ? '/' + config.s3Prefix : ''}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
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
              {testResult?.id === config.id && (
                <div className={`mt-2 text-xs ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  Test: {testResult.ok ? 'ok' : 'error'} ({testResult.latencyMs}ms){testResult.error ? ` — ${testResult.error.message}` : ''}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => handleTest(config.id)} disabled={testConfig.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`test-backup-${config.id}`}>
                  <TestTube size={12} /> Test Connection
                </button>
                {deleteConfirmId === config.id ? (
                  <div className="flex gap-1">
                    <button type="button" onClick={() => handleDelete(config.id)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button>
                    <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setDeleteConfirmId(config.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-backup-${config.id}`}>
                    <Trash2 size={12} /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
