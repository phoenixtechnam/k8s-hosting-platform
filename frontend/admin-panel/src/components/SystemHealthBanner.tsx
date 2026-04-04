import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, XCircle, X } from 'lucide-react';
import { usePlatformStatus } from '@/hooks/use-dashboard';

export default function SystemHealthBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data: statusRes } = usePlatformStatus();

  const status = statusRes?.data?.status;
  const services = statusRes?.data?.services;

  // Only show when system is degraded or unhealthy
  if (!status || status === 'healthy' || dismissed) {
    return null;
  }

  const isUnhealthy = status === 'unhealthy';
  const failedServices = services
    ? Object.entries(services)
        .filter(([, s]) => s === 'error' || s === 'degraded')
        .map(([name, s]) => ({ name, status: s }))
    : [];

  const Icon = isUnhealthy ? XCircle : AlertTriangle;
  const borderColor = isUnhealthy
    ? 'border-red-300 dark:border-red-800'
    : 'border-amber-300 dark:border-amber-800';
  const bgColor = isUnhealthy
    ? 'bg-red-50 dark:bg-red-900/30'
    : 'bg-amber-50 dark:bg-amber-900/30';
  const textColor = isUnhealthy
    ? 'text-red-800 dark:text-red-200'
    : 'text-amber-800 dark:text-amber-200';
  const iconColor = isUnhealthy
    ? 'text-red-500 dark:text-red-400'
    : 'text-amber-500 dark:text-amber-400';
  const dismissColor = isUnhealthy
    ? 'text-red-600 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-800'
    : 'text-amber-600 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800';

  return (
    <div
      data-testid="system-health-banner"
      className={`mx-4 mt-4 lg:mx-6 lg:mt-6 rounded-lg border ${borderColor} ${bgColor} px-4 py-3`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className={`flex items-center gap-2 text-sm ${textColor}`}>
          <Icon size={16} className={`shrink-0 ${iconColor}`} />
          <span>
            <strong>System {isUnhealthy ? 'unhealthy' : 'degraded'}</strong>
            {failedServices.length > 0 && (
              <>
                {' — '}
                {failedServices.map((s, i) => (
                  <span key={s.name}>
                    {i > 0 ? ', ' : ''}
                    <span className="font-medium">{s.name}</span> ({s.status})
                  </span>
                ))}
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            to="/monitoring/health"
            className={`text-sm font-medium underline ${textColor}`}
          >
            View details
          </Link>
          <button
            type="button"
            data-testid="system-health-dismiss"
            onClick={() => setDismissed(true)}
            className={`rounded-md p-1 ${dismissColor} transition-colors`}
            aria-label="Dismiss health warning"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
