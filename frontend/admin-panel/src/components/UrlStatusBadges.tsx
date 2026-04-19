import { CheckCircle2, AlertCircle, XCircle, Circle, Loader2 } from 'lucide-react';
import type { PanelUrlHealth, DnsStatus, SslStatus } from '@/hooks/use-url-health';

/**
 * Two-pill status badge shown next to each panel URL input.
 * Colors: green = all good, amber = transitional / warnable, red = failed,
 * gray = not applicable / unknown.
 *
 * The tooltip (native `title`) surfaces the probe's `reason` on hover, so
 * failure diagnostics are one hover away without a modal. Screen readers
 * get the same info via aria-label.
 */

interface BadgeSpec {
  readonly label: string;
  readonly color: 'green' | 'amber' | 'red' | 'gray';
  readonly tooltip: string;
  readonly icon: 'check' | 'alert' | 'x' | 'dot' | 'loader';
}

function dnsBadge(health: PanelUrlHealth | undefined): BadgeSpec {
  if (!health || health.dns.status === 'not-configured') {
    return { label: 'DNS', color: 'gray', tooltip: 'No URL configured yet.', icon: 'dot' };
  }
  const { status, addresses, reason } = health.dns;
  switch (status as DnsStatus) {
    case 'resolved':
      return {
        label: 'DNS',
        color: 'green',
        tooltip: `Resolves to: ${(addresses ?? []).join(', ') || 'unknown'}`,
        icon: 'check',
      };
    case 'unresolved':
      return {
        label: 'DNS',
        color: 'amber',
        tooltip: reason ?? 'Hostname not found in public DNS.',
        icon: 'alert',
      };
    case 'timeout':
      return {
        label: 'DNS',
        color: 'amber',
        tooltip: reason ?? 'DNS lookup timed out.',
        icon: 'loader',
      };
    case 'error':
      return { label: 'DNS', color: 'red', tooltip: reason ?? 'DNS lookup failed.', icon: 'x' };
    default:
      return { label: 'DNS', color: 'gray', tooltip: 'Unknown DNS state.', icon: 'dot' };
  }
}

function sslBadge(health: PanelUrlHealth | undefined): BadgeSpec {
  if (!health || health.ssl.status === 'not-configured') {
    return { label: 'SSL', color: 'gray', tooltip: 'No URL configured yet.', icon: 'dot' };
  }
  const { status, reason, notAfter, daysUntilExpiry, expiringSoon } = health.ssl;
  switch (status as SslStatus) {
    case 'ready': {
      const expiryLine = notAfter ? ` · expires ${new Date(notAfter).toLocaleDateString()}` : '';
      if (expiringSoon && typeof daysUntilExpiry === 'number') {
        return {
          label: 'SSL',
          color: 'amber',
          tooltip: `Ready, but renews soon (${daysUntilExpiry} days)${expiryLine}`,
          icon: 'alert',
        };
      }
      return { label: 'SSL', color: 'green', tooltip: `Certificate ready${expiryLine}`, icon: 'check' };
    }
    case 'pending':
      return {
        label: 'SSL',
        color: 'amber',
        tooltip: reason ?? 'cert-manager is issuing the certificate…',
        icon: 'loader',
      };
    case 'failed':
      return {
        label: 'SSL',
        color: 'red',
        tooltip: reason ?? 'Certificate issuance failed.',
        icon: 'x',
      };
    case 'missing':
      return {
        label: 'SSL',
        color: 'gray',
        tooltip: reason ?? 'No Certificate resource exists yet.',
        icon: 'dot',
      };
    case 'unknown':
      return {
        label: 'SSL',
        color: 'gray',
        tooltip: reason ?? 'Cannot read certificate status.',
        icon: 'dot',
      };
    default:
      return { label: 'SSL', color: 'gray', tooltip: 'Unknown TLS state.', icon: 'dot' };
  }
}

const COLOR_CLASSES: Record<BadgeSpec['color'], string> = {
  green: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  amber: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  red: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
  gray: 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700',
};

function IconFor({ kind }: { readonly kind: BadgeSpec['icon'] }) {
  if (kind === 'check') return <CheckCircle2 size={11} />;
  if (kind === 'alert') return <AlertCircle size={11} />;
  if (kind === 'x') return <XCircle size={11} />;
  if (kind === 'loader') return <Loader2 size={11} className="animate-spin" />;
  return <Circle size={11} />;
}

function Pill({ spec, testId }: { readonly spec: BadgeSpec; readonly testId: string }) {
  return (
    <span
      title={spec.tooltip}
      aria-label={`${spec.label}: ${spec.tooltip}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${COLOR_CLASSES[spec.color]}`}
      data-testid={testId}
      data-color={spec.color}
    >
      <IconFor kind={spec.icon} />
      {spec.label}
    </span>
  );
}

export interface UrlStatusBadgesProps {
  readonly panel: 'admin' | 'client';
  readonly health: PanelUrlHealth | undefined;
}

export default function UrlStatusBadges({ panel, health }: UrlStatusBadgesProps) {
  return (
    <div className="flex items-center gap-1.5" data-testid={`url-status-${panel}`}>
      <Pill spec={dnsBadge(health)} testId={`status-${panel}-dns`} />
      <Pill spec={sslBadge(health)} testId={`status-${panel}-ssl`} />
    </div>
  );
}
