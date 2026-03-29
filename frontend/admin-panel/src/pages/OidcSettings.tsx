import { useState, type FormEvent } from 'react';
import {
  Shield, Loader2, AlertCircle, CheckCircle, Plus, Trash2, Plug, Edit,
  Save, X, AlertTriangle, KeyRound,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useOidcProviders, useCreateOidcProvider, useUpdateOidcProvider, useDeleteOidcProvider,
  useTestOidcProvider, useOidcGlobalSettings, useSaveOidcGlobalSettings,
  type OidcProvider,
} from '@/hooks/use-oidc-settings';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

export default function OidcSettings() {
  const { data: providersRes, isLoading: pLoading } = useOidcProviders();
  const { data: settingsRes, isLoading: sLoading } = useOidcGlobalSettings();
  const providers = providersRes?.data ?? [];
  const globalSettings = settingsRes?.data;

  if (pLoading || sLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;
  }

  const hasAdminProvider = providers.some((p) => p.panelScope === 'admin' && p.enabled);
  const hasClientProvider = providers.some((p) => p.panelScope === 'client' && p.enabled);

  return (
    <div className="space-y-6" data-testid="oidc-settings-page">
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">OIDC / SSO Configuration</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure identity providers and authentication settings.</p>
        </div>
      </div>

      {/* Issue #5: Providers ABOVE auth settings */}
      <ProvidersSection providers={providers} />
      <GlobalSettingsSection
        settings={globalSettings}
        hasAdminProvider={hasAdminProvider}
        hasClientProvider={hasClientProvider}
      />
    </div>
  );
}

// ─── Global Settings (below providers) ───────────────────────────────────────

function GlobalSettingsSection({ settings, hasAdminProvider, hasClientProvider }: {
  readonly settings: { disableLocalAuthAdmin: boolean; disableLocalAuthClient: boolean; hasBreakGlassSecret: boolean } | undefined;
  readonly hasAdminProvider: boolean;
  readonly hasClientProvider: boolean;
}) {
  const saveSettings = useSaveOidcGlobalSettings();
  const [disableAdmin, setDisableAdmin] = useState(settings?.disableLocalAuthAdmin ?? false);
  const [disableClient, setDisableClient] = useState(settings?.disableLocalAuthClient ?? false);
  const [breakGlassSecret, setBreakGlassSecret] = useState('');
  const [showWarning, setShowWarning] = useState(false);
  const [warningChecks, setWarningChecks] = useState({ tested: false, secretSet: false });

  // Issue #4: break-glass disabled until admin provider exists
  const canSetBreakGlass = hasAdminProvider;
  // Issue #2: client toggle disabled until client provider exists
  const canDisableClient = hasClientProvider;
  // Issue #3: admin toggle disabled until admin provider + break-glass exists
  const canDisableAdmin = hasAdminProvider && (settings?.hasBreakGlassSecret || breakGlassSecret.length > 0);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (disableAdmin && !settings?.disableLocalAuthAdmin) { setShowWarning(true); return; }
    await doSave();
  };

  const doSave = async () => {
    try {
      await saveSettings.mutateAsync({
        disable_local_auth_admin: disableAdmin,
        disable_local_auth_client: disableClient,
        break_glass_secret: breakGlassSecret || undefined,
      });
      setBreakGlassSecret('');
      setShowWarning(false);
    } catch { /* error shown */ }
  };

  return (
    <form onSubmit={handleSave} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="global-settings-section">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Authentication Settings</h2>

      {/* Issue #2 */}
      <label className={clsx('flex items-start gap-3', !canDisableClient && 'opacity-50')}>
        <input type="checkbox" checked={disableClient} onChange={(e) => setDisableClient(e.target.checked)} disabled={!canDisableClient} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed" data-testid="disable-local-client-toggle" />
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Disable Local Auth for Client Panel</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {canDisableClient ? 'Clients must use SSO. Email/password login blocked.' : 'Enable a client-scoped OIDC provider first.'}
          </p>
        </div>
      </label>

      {/* Issue #3 */}
      <label className={clsx('flex items-start gap-3', !canDisableAdmin && 'opacity-50')}>
        <input type="checkbox" checked={disableAdmin} onChange={(e) => setDisableAdmin(e.target.checked)} disabled={!canDisableAdmin} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed" data-testid="disable-local-admin-toggle" />
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Disable Local Auth for Admin Panel</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {canDisableAdmin ? 'Admins must use SSO. Requires a break-glass secret.' : hasAdminProvider ? 'Set a break-glass secret first.' : 'Enable an admin-scoped OIDC provider and set a break-glass secret first.'}
          </p>
        </div>
      </label>

      {/* Issue #4 */}
      <div className={clsx(!canSetBreakGlass && 'opacity-50')}>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"><KeyRound size={14} /> Break-Glass Emergency Secret</label>
        <input type="password" className={INPUT_CLASS} placeholder={settings?.hasBreakGlassSecret ? '(set — enter new value to change)' : 'Set emergency secret'} value={breakGlassSecret} onChange={(e) => setBreakGlassSecret(e.target.value)} disabled={!canSetBreakGlass} data-testid="break-glass-input" />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {canSetBreakGlass ? 'Used at /login?emergency=true when SSO is down.' : 'Enable an admin-scoped OIDC provider first.'}
        </p>
      </div>

      {saveSettings.error && <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{saveSettings.error instanceof Error ? saveSettings.error.message : 'Failed'}</div>}
      {saveSettings.isSuccess && <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400"><CheckCircle size={14} /> Saved.</div>}

      <div className="flex justify-end">
        <button type="submit" disabled={saveSettings.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="save-global-settings">
          {saveSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>

      {showWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowWarning(false)} />
          <div className="relative w-full max-w-md rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl" data-testid="disable-admin-warning">
            <div className="flex items-center gap-3 mb-4"><AlertTriangle size={24} className="text-amber-500 dark:text-amber-400" /><h3 className="text-lg font-semibold">Warning</h3></div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Disabling local auth for admin panel means all admins must use SSO. If the OIDC provider becomes unavailable, you will be locked out unless you have a break-glass secret.</p>
            <div className="space-y-3 mb-6">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={warningChecks.tested} onChange={(e) => setWarningChecks({ ...warningChecks, tested: e.target.checked })} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" /> I have tested OIDC login and it works</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={warningChecks.secretSet} onChange={(e) => setWarningChecks({ ...warningChecks, secretSet: e.target.checked })} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" /> I have configured a break-glass secret</label>
            </div>
            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => setShowWarning(false)} className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
              <button type="button" onClick={doSave} disabled={!warningChecks.tested || !warningChecks.secretSet || saveSettings.isPending} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50" data-testid="confirm-disable-admin-auth">I understand, disable local auth</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

// ─── Providers Section ───────────────────────────────────────────────────────

function ProvidersSection({ providers }: { readonly providers: readonly OidcProvider[] }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="providers-section">
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">OIDC Providers</h2>
        <button type="button" onClick={() => setShowAdd((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-provider-button">
          {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'Add Provider'}
        </button>
      </div>
      {showAdd && <AddProviderForm onClose={() => setShowAdd(false)} />}
      {providers.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No OIDC providers configured.</div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">{providers.map((p) => <ProviderRow key={p.id} provider={p} />)}</div>
      )}
    </div>
  );
}

function AddProviderForm({ onClose }: { readonly onClose: () => void }) {
  const create = useCreateOidcProvider();
  const [form, setForm] = useState({ display_name: '', issuer_url: '', client_id: '', client_secret: '', panel_scope: 'admin' as 'admin' | 'client' });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try { await create.mutateAsync({ ...form, enabled: true }); onClose(); } catch {}
  };

  return (
    <form onSubmit={handleSubmit} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3" data-testid="add-provider-form">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Display Name</label><input type="text" className={INPUT_CLASS} placeholder="Corporate SSO" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required data-testid="provider-name-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Issuer URL</label><input type="url" className={INPUT_CLASS} placeholder="https://dex.example.com" value={form.issuer_url} onChange={(e) => setForm({ ...form, issuer_url: e.target.value })} required data-testid="provider-issuer-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Client ID</label><input type="text" className={INPUT_CLASS} value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} required data-testid="provider-client-id-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Client Secret</label><input type="password" className={INPUT_CLASS} value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} required data-testid="provider-secret-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Panel Scope</label>
          <select className={INPUT_CLASS} value={form.panel_scope} onChange={(e) => setForm({ ...form, panel_scope: e.target.value as 'admin' | 'client' })} data-testid="provider-scope-select">
            <option value="admin">Admin Panel</option><option value="client">Client Panel</option>
          </select>
        </div>
      </div>
      {create.error && <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{create.error instanceof Error ? create.error.message : 'Failed'}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={create.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-provider">{create.isPending && <Loader2 size={14} className="animate-spin" />} Add Provider</button>
      </div>
    </form>
  );
}

// Issue #1: ProviderRow with inline edit
function ProviderRow({ provider }: { readonly provider: OidcProvider }) {
  const update = useUpdateOidcProvider();
  const del = useDeleteOidcProvider();
  const test = useTestOidcProvider();
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    display_name: provider.displayName,
    issuer_url: provider.issuerUrl,
    client_id: provider.clientId,
    client_secret: '',
    panel_scope: provider.panelScope as 'admin' | 'client',
  });

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        id: provider.id,
        display_name: editForm.display_name,
        issuer_url: editForm.issuer_url,
        client_id: editForm.client_id,
        client_secret: editForm.client_secret || undefined,
        panel_scope: editForm.panel_scope,
      });
      setEditing(false);
    } catch { /* error shown */ }
  };

  if (editing) {
    return (
      <form onSubmit={handleSaveEdit} className="bg-gray-50 dark:bg-gray-900 px-5 py-4 space-y-3" data-testid={`edit-provider-${provider.id}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Display Name</label><input type="text" className={INPUT_CLASS} value={editForm.display_name} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Issuer URL</label><input type="url" className={INPUT_CLASS} value={editForm.issuer_url} onChange={(e) => setEditForm({ ...editForm, issuer_url: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Client ID</label><input type="text" className={INPUT_CLASS} value={editForm.client_id} onChange={(e) => setEditForm({ ...editForm, client_id: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Client Secret</label><input type="password" className={INPUT_CLASS} placeholder="(unchanged)" value={editForm.client_secret} onChange={(e) => setEditForm({ ...editForm, client_secret: e.target.value })} /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Panel Scope</label>
            <select className={INPUT_CLASS} value={editForm.panel_scope} onChange={(e) => setEditForm({ ...editForm, panel_scope: e.target.value as 'admin' | 'client' })}>
              <option value="admin">Admin Panel</option><option value="client">Client Panel</option>
            </select>
          </div>
        </div>
        {update.error && <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{update.error instanceof Error ? update.error.message : 'Failed'}</div>}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
          <button type="submit" disabled={update.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
            {update.isPending && <Loader2 size={12} className="animate-spin" />} Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="px-5 py-4" data-testid={`provider-${provider.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={clsx('h-2 w-2 rounded-full', provider.enabled ? 'bg-green-500' : 'bg-gray-300')} />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{provider.displayName}</span>
          <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', provider.panelScope === 'admin' ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' : 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400')}>{provider.panelScope}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`edit-provider-${provider.id}`}><Edit size={12} /></button>
          <button type="button" onClick={() => update.mutate({ id: provider.id, enabled: !provider.enabled })} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`toggle-provider-${provider.id}`}>{provider.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" onClick={() => test.mutate(provider.id)} disabled={test.isPending} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50" data-testid={`test-provider-${provider.id}`}>{test.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}</button>
          {confirmDel ? (
            <><button type="button" onClick={async () => { await del.mutateAsync(provider.id); setConfirmDel(false); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button><button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button></>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md border border-red-200 dark:border-red-800 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-provider-${provider.id}`}><Trash2 size={12} /></button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400">{provider.issuerUrl}</p>
      {test.isSuccess && <div className="mt-2 flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle size={12} /> Connected ({(test.data as { data?: { keys_count?: number } })?.data?.keys_count} keys)</div>}
      {test.isError && <div className="mt-2 flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><AlertCircle size={12} /> {test.error instanceof Error ? test.error.message : 'Failed'}</div>}
    </div>
  );
}
