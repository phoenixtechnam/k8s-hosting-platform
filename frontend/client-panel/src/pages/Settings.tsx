import { Settings as SettingsIcon, CreditCard, Bell, Loader2, Lock, Shield, Network, Share2, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClientContext } from '@/hooks/use-client-context';
import { useSubscription } from '@/hooks/use-subscription';

export default function Settings() {
  const { clientId } = useClientContext();
  const { data, isLoading } = useSubscription(clientId ?? undefined);
  const sub = data?.data;
  const plan = sub?.plan;

  // Round-4 Phase C: real subscription data rendered here. The
  // backend GET endpoint now accepts client_admin + client_user
  // (scoped to the authenticated client's own id).
  const expiresAt = sub?.subscription_expires_at
    ? new Date(sub.subscription_expires_at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    : null;

  const statusStyles: Record<string, string> = {
    active: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    suspended: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="settings-heading">
          Account Settings
        </h1>
      </div>

      {/* Subscription Settings Section */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="subscription-section">
        <div className="mb-4 flex items-center gap-2">
          <CreditCard size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Subscription</h2>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" />
            Loading subscription…
          </div>
        )}

        {!isLoading && sub && (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="subscription-details">
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Current Plan</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="subscription-plan-name">
                {plan?.name ?? '—'}
                {plan?.code && (
                  <span className="ml-2 text-xs font-mono text-gray-400">({plan.code})</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Status</dt>
              <dd className="mt-1 text-sm" data-testid="subscription-status">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[sub.status] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
                >
                  {sub.status}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Monthly Price</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                {plan?.monthlyPriceUsd ? `$${plan.monthlyPriceUsd}` : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Next Renewal</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="subscription-expires">
                {expiresAt ?? '—'}
              </dd>
            </div>
            {plan && (
              <>
                <div>
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">CPU Limit</dt>
                  <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{plan.cpuLimit} cores</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Memory Limit</dt>
                  <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{plan.memoryLimit} GB</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Storage Limit</dt>
                  <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{plan.storageLimit} GB</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Max Mailboxes</dt>
                  <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{plan.maxMailboxes}</dd>
                </div>
              </>
            )}
          </dl>
        )}

        {!isLoading && !sub && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No subscription data available.
          </p>
        )}

        <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
          Contact support to change your subscription plan.
        </p>
      </div>

      {/*
        Notification Preferences Section
        Round-4 Phase A: the previous version rendered three interactive
        checkboxes with `defaultChecked` but no save mechanism, making
        users think they were toggling preferences when nothing was
        persisted. Per the gap scan MEDIUM-6, the section is now a
        read-only "coming soon" panel until a real backend endpoint
        exists. All notifications currently ship to the notifications
        dropdown — email delivery is enabled globally via
        OIDC_ENCRYPTION_KEY + the SMTP relay config on the platform.
      */}
      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
        data-testid="auth-providers-section"
      >
        <div className="mb-4 flex items-center gap-2">
          <Lock size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Access &amp; Network Providers
          </h2>
        </div>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Reusable providers used by the per-ingress Access Control tab and the per-app Network
          Access tab.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            to="/settings/oidc-providers"
            className="group flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            data-testid="settings-link-oidc"
          >
            <div className="flex items-center gap-3">
              <Lock size={18} className="text-gray-500 dark:text-gray-400 group-hover:text-blue-600" />
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">OIDC Providers</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">OAuth2 / OpenID Connect</div>
              </div>
            </div>
            <ChevronRight size={16} className="text-gray-400 group-hover:text-blue-600" />
          </Link>
          <Link
            to="/settings/mtls-providers"
            className="group flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            data-testid="settings-link-mtls"
          >
            <div className="flex items-center gap-3">
              <Shield size={18} className="text-gray-500 dark:text-gray-400 group-hover:text-blue-600" />
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">mTLS Providers</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">CA bundles + user certs</div>
              </div>
            </div>
            <ChevronRight size={16} className="text-gray-400 group-hover:text-blue-600" />
          </Link>
          <Link
            to="/settings/openziti-providers"
            className="group flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            data-testid="settings-link-openziti"
          >
            <div className="flex items-center gap-3">
              <Network size={18} className="text-gray-500 dark:text-gray-400 group-hover:text-blue-600" />
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">OpenZiti Providers</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Zero-trust mesh tunneler</div>
              </div>
            </div>
            <ChevronRight size={16} className="text-gray-400 group-hover:text-blue-600" />
          </Link>
          <Link
            to="/settings/zrok-providers"
            className="group flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            data-testid="settings-link-zrok"
          >
            <div className="flex items-center gap-3">
              <Share2 size={18} className="text-gray-500 dark:text-gray-400 group-hover:text-blue-600" />
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Zrok Providers</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Private share controllers</div>
              </div>
            </div>
            <ChevronRight size={16} className="text-gray-400 group-hover:text-blue-600" />
          </Link>
        </div>
      </div>

      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
        data-testid="notification-prefs-section"
      >
        <div className="mb-4 flex items-center gap-2">
          <Bell size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Notification Preferences
          </h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          All notifications currently land in the bell menu in the top right of the
          client panel. Per-category email delivery opt-outs will be added in a
          future release.
        </p>
      </div>
    </div>
  );
}
