import { useState, type FormEvent } from 'react';
import {
  Shield, ShieldCheck, Loader2, AlertCircle, CheckCircle, Plus, Trash2, Plug, Edit,
  Save, X, AlertTriangle, KeyRound, Copy, RefreshCw,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useOidcProviders, useCreateOidcProvider, useUpdateOidcProvider, useDeleteOidcProvider,
  useTestOidcProvider, useOidcGlobalSettings, useSaveOidcGlobalSettings, useRegenerateBreakGlass,
  useRegenerateCookieSecret,
  type OidcProvider, type OidcGlobalSettings,
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

      <ProvidersSection providers={providers} />
      <AuthenticationSection
        settings={globalSettings}
        hasAdminProvider={hasAdminProvider}
        hasClientProvider={hasClientProvider}
      />
    </div>
  );
}

// ─── Combined Authentication & Ingress Protection ────────────────────────────

function AuthenticationSection({ settings, hasAdminProvider, hasClientProvider }: {
  readonly settings: OidcGlobalSettings | undefined;
  readonly hasAdminProvider: boolean;
  readonly hasClientProvider: boolean;
}) {
  const saveSettings = useSaveOidcGlobalSettings();
  const regenerateBreakGlass = useRegenerateBreakGlass();
  const regenerateCookieSecret = useRegenerateCookieSecret();
  const [disableAdmin, setDisableAdmin] = useState(settings?.disableLocalAuthAdmin ?? false);
  const [disableClient, setDisableClient] = useState(settings?.disableLocalAuthClient ?? false);
  const [proxyAdmin, setProxyAdmin] = useState(settings?.proxyProtectAdmin ?? false);
  const [proxyClient, setProxyClient] = useState(settings?.proxyProtectClient ?? false);
  const [showWarning, setShowWarning] = useState(false);
  const [warningChecks, setWarningChecks] = useState({ tested: false, secretSet: false });
  const [bgCopied, setBgCopied] = useState(false);
  const [showCookieConfirm, setShowCookieConfirm] = useState(false);

  const canDisableClient = hasClientProvider;
  const canDisableAdmin = hasAdminProvider && !!settings?.breakGlassPath;

  const breakGlassUrl = settings?.breakGlassPath
    ? `${window.location.origin}/${settings.breakGlassPath}/`
    : null;

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
        proxy_protect_admin: proxyAdmin,
        proxy_protect_client: proxyClient,
      });
      setShowWarning(false);
    } catch { /* error shown */ }
  };

  return (
    <form onSubmit={handleSave} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="auth-ingress-section">
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-brand-500" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Authentication &amp; Ingress Protection</h2>
      </div>

      {/* ── Client Panel ── */}
      <label className={clsx('flex items-start gap-3', !canDisableClient && 'opacity-50')}>
        <input type="checkbox" checked={disableClient} onChange={(e) => setDisableClient(e.target.checked)} disabled={!canDisableClient} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed" data-testid="disable-local-client-toggle" />
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Disable Local Auth for Client Panel</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {canDisableClient ? 'Clients must use SSO. Email/password login blocked.' : 'Enable a client-scoped OIDC provider first.'}
          </p>
        </div>
      </label>

      {disableClient && (
        <label className={clsx('flex items-start gap-3 ml-6', !hasClientProvider && 'opacity-50')}>
          <input type="checkbox" checked={proxyClient} onChange={(e) => setProxyClient(e.target.checked)} disabled={!hasClientProvider} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed" data-testid="proxy-protect-client-toggle" />
          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Protect client panel via OAuth2 Proxy</span>
            <p className="text-xs text-gray-500 dark:text-gray-400">Unauthenticated users cannot reach the client panel without OIDC authentication.</p>
          </div>
        </label>
      )}

      {/* ── Admin Panel ── */}
      <label className={clsx('flex items-start gap-3', !canDisableAdmin && 'opacity-50')}>
        <input type="checkbox" checked={disableAdmin} onChange={(e) => setDisableAdmin(e.target.checked)} disabled={!canDisableAdmin} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed" data-testid="disable-local-admin-toggle" />
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Disable Local Auth for Admin Panel</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {canDisableAdmin ? 'Admins must use SSO. Break-glass URL available below.' : hasAdminProvider ? 'Generate a break-glass path first.' : 'Enable an admin-scoped OIDC provider first.'}
          </p>
        </div>
      </label>

      {disableAdmin && (
        <label className={clsx('flex items-start gap-3 ml-6', !hasAdminProvider && 'opacity-50')}>
          <input type="checkbox" checked={proxyAdmin} onChange={(e) => setProxyAdmin(e.target.checked)} disabled={!hasAdminProvider} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed" data-testid="proxy-protect-admin-toggle" />
          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Protect admin panel via OAuth2 Proxy</span>
            <p className="text-xs text-gray-500 dark:text-gray-400">Unauthenticated users cannot reach the admin panel without OIDC authentication.</p>
          </div>
        </label>
      )}

      {/* ── Break-Glass (shown when admin local auth is disabled) ── */}
      {disableAdmin && (
        <div className="ml-6 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2" data-testid="break-glass-section">
          <div className="flex items-center gap-2">
            <KeyRound size={14} className="text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-medium text-amber-800 dark:text-amber-300">Break-Glass Emergency Access</span>
          </div>
          {breakGlassUrl ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-mono text-gray-900 dark:text-gray-100 break-all" data-testid="break-glass-url">
                {breakGlassUrl}
              </code>
              <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(breakGlassUrl); setBgCopied(true); setTimeout(() => setBgCopied(false), 2000); } catch {} }} className="rounded-md border border-amber-300 dark:border-amber-700 p-2 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30" title="Copy URL">
                {bgCopied ? <CheckCircle size={14} /> : <Copy size={14} />}
              </button>
              <button type="button" onClick={async () => { try { await regenerateBreakGlass.mutateAsync(); } catch {} }} disabled={regenerateBreakGlass.isPending} className="rounded-md border border-amber-300 dark:border-amber-700 p-2 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50" title="Regenerate path">
                {regenerateBreakGlass.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-amber-700 dark:text-amber-400 italic">No break-glass path generated yet.</p>
              <button type="button" onClick={async () => { try { await regenerateBreakGlass.mutateAsync(); } catch {} }} disabled={regenerateBreakGlass.isPending} className="inline-flex items-center gap-1 rounded-md border border-amber-300 dark:border-amber-700 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50">
                {regenerateBreakGlass.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Generate
              </button>
            </div>
          )}
          <p className="text-xs text-amber-600 dark:text-amber-500">This URL bypasses OAuth2 Proxy for emergency admin access. Keep it secret.</p>
        </div>
      )}

      {/* ── Cookie Secret (shown when any proxy is enabled) ── */}
      {(proxyAdmin || proxyClient) && (
        <div className="ml-6 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3" data-testid="cookie-secret-section">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">OAuth2 Proxy Cookie Secret</span>
              <p className="text-xs text-gray-500 dark:text-gray-400">Auto-generated. Regenerate if compromised — invalidates all proxy sessions.</p>
            </div>
            <button type="button" onClick={() => setShowCookieConfirm(true)} disabled={regenerateCookieSecret.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 disabled:opacity-50" data-testid="regenerate-cookie-secret">
              {regenerateCookieSecret.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Regenerate
            </button>
          </div>
          {regenerateCookieSecret.isSuccess && <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400"><CheckCircle size={12} /> Cookie secret regenerated. Proxy pods restarting.</div>}
          {regenerateCookieSecret.isError && <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400"><AlertCircle size={12} /> {regenerateCookieSecret.error instanceof Error ? regenerateCookieSecret.error.message : 'Failed'}</div>}
        </div>
      )}

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
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Disabling local auth for admin panel means all admins must use SSO. If the OIDC provider becomes unavailable, use the break-glass URL above for emergency access.</p>
            <div className="space-y-3 mb-6">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={warningChecks.tested} onChange={(e) => setWarningChecks({ ...warningChecks, tested: e.target.checked })} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" /> I have tested OIDC login and it works</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={warningChecks.secretSet} onChange={(e) => setWarningChecks({ ...warningChecks, secretSet: e.target.checked })} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" /> I have saved the break-glass URL</label>
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

/* IngressProtectionSection removed — merged into AuthenticationSection above */

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
  const [form, setForm] = useState({
    display_name: '', issuer_url: '', client_id: '', client_secret: '',
    panel_scope: 'admin' as 'admin' | 'client',
    auto_provision: false, default_role: 'read_only', additional_claims: '',
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const additionalClaims = form.additional_claims
      ? form.additional_claims.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    try {
      await create.mutateAsync({
        display_name: form.display_name,
        issuer_url: form.issuer_url,
        client_id: form.client_id,
        client_secret: form.client_secret,
        panel_scope: form.panel_scope,
        enabled: true,
        auto_provision: form.auto_provision,
        default_role: form.panel_scope === 'admin' ? form.default_role : undefined,
        additional_claims: additionalClaims.length > 0 ? additionalClaims : undefined,
      });
      onClose();
    } catch {}
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

      {/* ── Auto-Provision Settings ── */}
      <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <label className="flex items-start gap-3">
          <input type="checkbox" checked={form.auto_provision} onChange={(e) => setForm({ ...form, auto_provision: e.target.checked })} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500" data-testid="provider-auto-provision-toggle" />
          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Auto-Provision Non-Existing Users</span>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {form.panel_scope === 'admin'
                ? 'Automatically create admin accounts for unrecognized OIDC users'
                : 'Automatically create client accounts for unrecognized OIDC users'}
            </p>
          </div>
        </label>

        {form.panel_scope === 'admin' && (
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Default Role for Auto-Provisioned Users</label>
            <select className={INPUT_CLASS} value={form.default_role} onChange={(e) => setForm({ ...form, default_role: e.target.value })} data-testid="provider-default-role-select">
              <option value="read_only">Read Only</option>
              <option value="support">Support</option>
              <option value="billing">Billing</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Additional OIDC Claims</label>
          <input type="text" className={INPUT_CLASS} placeholder="organization, company_name" value={form.additional_claims} onChange={(e) => setForm({ ...form, additional_claims: e.target.value })} data-testid="provider-additional-claims-input" />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Comma-separated claim names to request from the OIDC provider</p>
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
    auto_provision: provider.autoProvision ?? false,
    default_role: provider.defaultRole ?? 'read_only',
    additional_claims: (provider.additionalClaims ?? []).join(', '),
  });

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    const additionalClaims = editForm.additional_claims
      ? editForm.additional_claims.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    try {
      await update.mutateAsync({
        id: provider.id,
        display_name: editForm.display_name,
        issuer_url: editForm.issuer_url,
        client_id: editForm.client_id,
        client_secret: editForm.client_secret || undefined,
        panel_scope: editForm.panel_scope,
        auto_provision: editForm.auto_provision,
        default_role: editForm.panel_scope === 'admin' ? editForm.default_role : undefined,
        additional_claims: additionalClaims.length > 0 ? additionalClaims : undefined,
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

        {/* ── Auto-Provision Settings ── */}
        <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
          <label className="flex items-start gap-3">
            <input type="checkbox" checked={editForm.auto_provision} onChange={(e) => setEditForm({ ...editForm, auto_provision: e.target.checked })} className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500" data-testid="edit-auto-provision-toggle" />
            <div>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Auto-Provision Non-Existing Users</span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {editForm.panel_scope === 'admin'
                  ? 'Automatically create admin accounts for unrecognized OIDC users'
                  : 'Automatically create client accounts for unrecognized OIDC users'}
              </p>
            </div>
          </label>

          {editForm.panel_scope === 'admin' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Default Role for Auto-Provisioned Users</label>
              <select className={INPUT_CLASS} value={editForm.default_role} onChange={(e) => setEditForm({ ...editForm, default_role: e.target.value })} data-testid="edit-default-role-select">
                <option value="read_only">Read Only</option>
                <option value="support">Support</option>
                <option value="billing">Billing</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Additional OIDC Claims</label>
            <input type="text" className={INPUT_CLASS} placeholder="organization, company_name" value={editForm.additional_claims} onChange={(e) => setEditForm({ ...editForm, additional_claims: e.target.value })} data-testid="edit-additional-claims-input" />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Comma-separated claim names to request from the OIDC provider</p>
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
          {provider.autoProvision && <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400">auto-provision</span>}
          {provider.autoProvision && provider.defaultRole && provider.panelScope === 'admin' && <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{provider.defaultRole.replace('_', ' ')}</span>}
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
