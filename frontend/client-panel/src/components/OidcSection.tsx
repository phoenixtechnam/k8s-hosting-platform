import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { Lock, AlertCircle, CheckCircle, Loader2, Plus, Trash2, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  useIngressAuth,
  useUpsertIngressAuth,
  useDeleteIngressAuth,
  useTestIngressAuth,
  useOidcProviders,
} from '@/hooks/use-ingress-auth';
import type {
  ClaimRule,
  ClaimOperator,
  IngressAuthConfigInput,
  OidcAuthMethod,
  OidcResponseType,
} from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const CLAIM_OPERATORS: ClaimOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'regex',
];

interface Props {
  readonly clientId: string;
  readonly routeId: string;
  readonly hostname: string;
}

function Toggle({
  checked,
  onChange,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
      )}
      data-testid={testId}
    >
      <span
        className={clsx(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

export default function OidcSection({ clientId, routeId, hostname }: Props) {
  const { data: existing, isLoading } = useIngressAuth(clientId, routeId);
  const upsert = useUpsertIngressAuth(clientId, routeId);
  const remove = useDeleteIngressAuth(clientId, routeId);
  const test = useTestIngressAuth(clientId, routeId);
  const { data: providers } = useOidcProviders(clientId);

  const [isOpen, setIsOpen] = useState(true);
  const [providerMode, setProviderMode] = useState<'existing' | 'new'>('new');
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');

  const [enabled, setEnabled] = useState(false);
  const [issuerUrl, setIssuerUrl] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authMethod, setAuthMethod] = useState<OidcAuthMethod>('client_secret_basic');
  const [responseType, setResponseType] = useState<OidcResponseType>('code');
  const [usePkce, setUsePkce] = useState(true);
  const [scopes, setScopes] = useState('openid profile email');
  const [postLoginRedirectUrl, setPostLoginRedirectUrl] = useState('');
  const [allowedEmails, setAllowedEmails] = useState('');
  const [allowedEmailDomains, setAllowedEmailDomains] = useState('');
  const [allowedGroups, setAllowedGroups] = useState('');
  const [claimRules, setClaimRules] = useState<ClaimRule[]>([]);
  const [passAuth, setPassAuth] = useState(true);
  const [passAccess, setPassAccess] = useState(true);
  const [passId, setPassId] = useState(true);
  const [passUser, setPassUser] = useState(true);
  const [setX, setSetX] = useState(true);
  const [cookieDomain, setCookieDomain] = useState('');
  const [cookieRefresh, setCookieRefresh] = useState(3600);
  const [cookieExpire, setCookieExpire] = useState(86400);

  useEffect(() => {
    if (!existing) return;
    setEnabled(existing.enabled);
    setSelectedProviderId(existing.providerId);
    setProviderMode('existing');
    setIssuerUrl(existing.issuerUrl);
    setOidcClientId(existing.clientId);
    setClientSecret('');
    setAuthMethod(existing.authMethod);
    setResponseType(existing.responseType);
    setUsePkce(existing.usePkce);
    setScopes(existing.scopes);
    setPostLoginRedirectUrl(existing.postLoginRedirectUrl ?? '');
    setAllowedEmails(existing.allowedEmails ?? '');
    setAllowedEmailDomains(existing.allowedEmailDomains ?? '');
    setAllowedGroups(existing.allowedGroups ?? '');
    setClaimRules(existing.claimRules ? [...existing.claimRules] : []);
    setPassAuth(existing.passAuthorizationHeader);
    setPassAccess(existing.passAccessToken);
    setPassId(existing.passIdToken);
    setPassUser(existing.passUserHeaders);
    setSetX(existing.setXauthrequest);
    setCookieDomain(existing.cookieDomain ?? '');
    setCookieRefresh(existing.cookieRefreshSeconds);
    setCookieExpire(existing.cookieExpireSeconds);
  }, [existing]);

  const selectedProvider = useMemo(
    () => providers?.find((p) => p.id === selectedProviderId),
    [providers, selectedProviderId],
  );
  useEffect(() => {
    if (providerMode !== 'existing' || !selectedProvider) return;
    setIssuerUrl(selectedProvider.issuerUrl);
    setOidcClientId(selectedProvider.oauthClientId);
    setAuthMethod(selectedProvider.authMethod);
    setResponseType(selectedProvider.responseType);
    setUsePkce(selectedProvider.usePkce);
    if (!existing?.scopesOverride) setScopes(selectedProvider.defaultScopes);
  }, [selectedProvider, providerMode, existing?.scopesOverride]);

  const callbackUrl = existing?.callbackUrl ?? `https://${hostname}/oauth2/callback`;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const basePayload = {
      enabled,
      scopes,
      postLoginRedirectUrl: postLoginRedirectUrl.trim() || null,
      allowedEmails: allowedEmails || null,
      allowedEmailDomains: allowedEmailDomains || null,
      allowedGroups: allowedGroups || null,
      claimRules: claimRules.length > 0 ? claimRules : null,
      passAuthorizationHeader: passAuth,
      passAccessToken: passAccess,
      passIdToken: passId,
      passUserHeaders: passUser,
      setXauthrequest: setX,
      cookieDomain: cookieDomain || null,
      cookieRefreshSeconds: cookieRefresh,
      cookieExpireSeconds: cookieExpire,
    };

    let payload: IngressAuthConfigInput;
    if (providerMode === 'existing' && selectedProviderId) {
      payload = { ...basePayload, providerId: selectedProviderId };
    } else {
      payload = {
        ...basePayload,
        issuerUrl,
        clientId: oidcClientId,
        ...(clientSecret ? { clientSecret } : {}),
        authMethod,
        responseType,
        usePkce,
      };
    }
    await upsert.mutateAsync(payload);
    setClientSecret('');
  };

  const handleDelete = async () => {
    if (!confirm('Disable OIDC authentication for this ingress?')) return;
    await remove.mutateAsync();
  };

  const handleTest = async () => {
    await test.mutateAsync(issuerUrl);
  };

  const addClaimRule = () => {
    setClaimRules((prev) => [...prev, { claim: '', operator: 'equals', value: '' }]);
  };
  const updateClaimRule = (idx: number, patch: Partial<ClaimRule>) => {
    setClaimRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removeClaimRule = (idx: number) => {
    setClaimRules((prev) => prev.filter((_, i) => i !== idx));
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden" data-testid="oidc-section">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Lock size={18} className="text-gray-700 dark:text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">OIDC Authentication</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className={clsx(
            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
            enabled
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
          )}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
          {isOpen ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
        </div>
      </button>

      {isOpen && (
        <form
          onSubmit={handleSubmit}
          className="border-t border-gray-200 dark:border-gray-700 p-5 space-y-4"
        >
          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Enabled</span>
            <Toggle checked={enabled} onChange={setEnabled} testId="oidc-enabled" />
          </label>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Gate this ingress behind OIDC login. After authenticating, the upstream
            app receives identity headers (X-Auth-Request-User, -Email, etc.).
          </p>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">Identity Provider</legend>
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Pick an existing provider or create one inline. Manage all providers (rename, rotate
                secret, delete) on the dedicated settings page.
              </p>
              <Link
                to="/settings/oidc-providers"
                className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                data-testid="oidc-manage-providers-link"
              >
                Manage providers <ExternalLink size={12} />
              </Link>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  checked={providerMode === 'existing'}
                  onChange={() => setProviderMode('existing')}
                  disabled={!providers || providers.length === 0}
                  data-testid="provider-mode-existing"
                />
                Use existing
                {providers && providers.length > 0 && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">({providers.length} available)</span>
                )}
              </label>
              <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  checked={providerMode === 'new'}
                  onChange={() => setProviderMode('new')}
                  data-testid="provider-mode-new"
                />
                New (inline)
              </label>
            </div>

            {providerMode === 'existing' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Provider</label>
                <select
                  className={`${INPUT_CLASS} mt-1`}
                  value={selectedProviderId}
                  onChange={(e) => setSelectedProviderId(e.target.value)}
                  data-testid="provider-select"
                  required={enabled}
                >
                  <option value="">— pick a provider —</option>
                  {(providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.issuerUrl}) — used by {p.consumerCount} ingress{p.consumerCount === 1 ? '' : 'es'}
                    </option>
                  ))}
                </select>
                {selectedProvider && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Issuer: {selectedProvider.issuerUrl} · Client: {selectedProvider.oauthClientId}
                  </p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="oidc-issuer" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Issuer URL</label>
                  <input
                    id="oidc-issuer"
                    className={`${INPUT_CLASS} mt-1`}
                    value={issuerUrl}
                    onChange={(e) => setIssuerUrl(e.target.value)}
                    placeholder="https://auth.example.com/"
                    data-testid="oidc-issuer"
                    required={enabled}
                  />
                </div>
                <div>
                  <label htmlFor="oidc-cid" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Client ID</label>
                  <input
                    id="oidc-cid"
                    className={`${INPUT_CLASS} mt-1`}
                    value={oidcClientId}
                    onChange={(e) => setOidcClientId(e.target.value)}
                    data-testid="oidc-client-id"
                    required={enabled}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="oidc-secret" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Client Secret
                    {existing?.clientSecretSet && (
                      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">(set — leave blank to keep existing)</span>
                    )}
                  </label>
                  <input
                    id="oidc-secret"
                    type="password"
                    className={`${INPUT_CLASS} mt-1`}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    data-testid="oidc-client-secret"
                  />
                </div>
              </div>
            )}
          </fieldset>

          <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-3 py-2">
            <p className="text-xs font-medium text-blue-900 dark:text-blue-200">
              Register this callback URL at your IdP:
            </p>
            <code className="block mt-1 text-xs text-blue-900 dark:text-blue-100 break-all" data-testid="oidc-callback-url">
              {callbackUrl}
            </code>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Auth Method</label>
              <select
                className={`${INPUT_CLASS} mt-1`}
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as OidcAuthMethod)}
                data-testid="oidc-auth-method"
              >
                <option value="client_secret_basic">Basic</option>
                <option value="client_secret_post">Post</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Response Type</label>
              <select
                className={`${INPUT_CLASS} mt-1`}
                value={responseType}
                onChange={(e) => setResponseType(e.target.value as OidcResponseType)}
                data-testid="oidc-response-type"
              >
                <option value="code">code</option>
                <option value="id_token">id_token</option>
                <option value="code_id_token">code id_token</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Scopes</label>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
                data-testid="oidc-scopes"
              />
            </div>
          </div>

          <label className="flex items-center justify-between">
            <span className="text-sm text-gray-700 dark:text-gray-300">Use PKCE (S256) — recommended</span>
            <Toggle checked={usePkce} onChange={setUsePkce} testId="oidc-pkce" />
          </label>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">Allow List</legend>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Emails (comma-separated)</label>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={allowedEmails}
                onChange={(e) => setAllowedEmails(e.target.value)}
                placeholder="alice@example.com, bob@example.com"
                data-testid="oidc-allowed-emails"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Email Domains (comma-separated)</label>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={allowedEmailDomains}
                onChange={(e) => setAllowedEmailDomains(e.target.value)}
                placeholder="example.com, partner.org"
                data-testid="oidc-allowed-domains"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Groups (comma-separated)</label>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={allowedGroups}
                onChange={(e) => setAllowedGroups(e.target.value)}
                placeholder="engineers, admins"
                data-testid="oidc-allowed-groups"
              />
            </div>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">Custom Claim Rules</legend>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              All rules must pass (AND). E.g. <code>membership contains paid</code>.
            </p>
            {claimRules.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">No rules — any authenticated user passes.</p>
            )}
            {claimRules.map((rule, idx) => (
              <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                <input
                  className={`${INPUT_CLASS} sm:col-span-4`}
                  placeholder="claim (e.g. membership)"
                  value={rule.claim}
                  onChange={(e) => updateClaimRule(idx, { claim: e.target.value })}
                  data-testid={`claim-rule-claim-${idx}`}
                />
                <select
                  className={`${INPUT_CLASS} sm:col-span-3`}
                  value={rule.operator}
                  onChange={(e) => updateClaimRule(idx, { operator: e.target.value as ClaimOperator })}
                  data-testid={`claim-rule-op-${idx}`}
                >
                  {CLAIM_OPERATORS.map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
                <input
                  className={`${INPUT_CLASS} sm:col-span-4`}
                  placeholder={rule.operator === 'in' || rule.operator === 'not_in' ? 'value1, value2' : 'value'}
                  value={Array.isArray(rule.value) ? rule.value.join(', ') : rule.value ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    const parsed = (rule.operator === 'in' || rule.operator === 'not_in')
                      ? v.split(',').map((s) => s.trim()).filter(Boolean)
                      : v;
                    updateClaimRule(idx, { value: parsed });
                  }}
                  disabled={rule.operator === 'exists'}
                  data-testid={`claim-rule-value-${idx}`}
                />
                <button
                  type="button"
                  onClick={() => removeClaimRule(idx)}
                  className="sm:col-span-1 inline-flex items-center justify-center rounded-lg border border-red-200 dark:border-red-900 px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                  data-testid={`claim-rule-remove-${idx}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addClaimRule}
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
              data-testid="claim-rule-add"
            >
              <Plus size={14} /> Add claim rule
            </button>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-2">Identity headers passed to upstream</legend>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">X-Auth-Request-User / -Email / -Preferred-Username</span>
              <Toggle checked={passUser} onChange={setPassUser} testId="pass-user" />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">X-Auth-Request-Access-Token</span>
              <Toggle checked={passAccess} onChange={setPassAccess} testId="pass-access" />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">X-Auth-Request-Id-Token (required when claim rules are set)</span>
              <Toggle checked={passId} onChange={setPassId} testId="pass-id" />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">Authorization: Bearer &lt;id_token&gt;</span>
              <Toggle checked={passAuth} onChange={setPassAuth} testId="pass-auth" />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-sm text-gray-700 dark:text-gray-300">Enable X-Auth-Request-* family (required for groups header)</span>
              <Toggle checked={setX} onChange={setSetX} testId="pass-xauth" />
            </label>
          </fieldset>

          <div>
            <label htmlFor="oidc-post-login" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Post-login redirect URL <span className="text-xs text-gray-500 dark:text-gray-400">(optional)</span>
            </label>
            <input
              id="oidc-post-login"
              type="url"
              className={`${INPUT_CLASS} mt-1`}
              value={postLoginRedirectUrl}
              onChange={(e) => setPostLoginRedirectUrl(e.target.value)}
              placeholder={`https://${hostname}/dashboard`}
              data-testid="oidc-post-login"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Forward users to a fixed page after login (e.g. into your app's own
              OIDC callback or a static landing page). Leave blank to honour the
              original request URL.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Cookie Domain (optional)</label>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={cookieDomain}
                onChange={(e) => setCookieDomain(e.target.value)}
                placeholder={hostname}
                data-testid="oidc-cookie-domain"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Cookie Refresh (s)</label>
              <input
                type="number"
                className={`${INPUT_CLASS} mt-1`}
                value={cookieRefresh}
                onChange={(e) => setCookieRefresh(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Cookie Expire (s)</label>
              <input
                type="number"
                className={`${INPUT_CLASS} mt-1`}
                value={cookieExpire}
                onChange={(e) => setCookieExpire(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={!issuerUrl || test.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              data-testid="oidc-test"
            >
              {test.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Test issuer
            </button>
            {test.data && (
              <span className={`inline-flex items-center gap-1 text-sm ${test.data.ok ? 'text-green-600' : 'text-red-600'}`}>
                {test.data.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                {test.data.ok ? 'Discovery OK' : test.data.error}
              </span>
            )}
          </div>

          {existing?.lastError && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-800 dark:text-red-200">
              <strong>Reconcile error:</strong> {existing.lastError}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              type="submit"
              disabled={upsert.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="oidc-save"
            >
              {upsert.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Save
            </button>
            {existing && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={remove.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                data-testid="oidc-disable"
              >
                Disable
              </button>
            )}
            {upsert.error && (
              <span className="text-sm text-red-600">
                {upsert.error instanceof Error ? upsert.error.message : 'Save failed'}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
