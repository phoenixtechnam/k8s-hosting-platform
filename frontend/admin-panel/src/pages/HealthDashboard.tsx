import { Loader2, RefreshCw, Heart, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { useHealth } from '@/hooks/use-health';
import { useQueryClient } from '@tanstack/react-query';

const statusConfig = {
  ok: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-900/20', border: 'border-green-200 dark:border-green-800', label: 'Healthy' },
  error: { icon: XCircle, color: 'text-red-500 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-800', label: 'Error' },
  degraded: { icon: AlertTriangle, color: 'text-amber-500 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', label: 'Degraded' },
} as const;

const overallConfig = {
  healthy: { color: 'text-green-600 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/20', label: 'All Systems Operational' },
  degraded: { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/20', label: 'Some Systems Degraded' },
  unhealthy: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/20', label: 'System Issues Detected' },
} as const;

export default function HealthDashboard() {
  const { data: response, isLoading, isFetching } = useHealth();
  const qc = useQueryClient();

  const health = response?.data;
  const overall = health?.overall ?? 'healthy';
  const services = health?.services ?? [];
  const oc = overallConfig[overall];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Heart size={28} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="health-heading">System Health</h1>
        </div>
        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: ['health'] })}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
          data-testid="refresh-health"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-brand-500" /></div>
      )}

      {!isLoading && health && (
        <>
          <div className={`rounded-xl border p-5 ${oc.bg} ${overall === 'healthy' ? 'border-green-200 dark:border-green-800' : overall === 'degraded' ? 'border-amber-200 dark:border-amber-800' : 'border-red-200 dark:border-red-800'}`} data-testid="overall-status">
            <div className="flex items-center gap-3">
              <div className={`text-2xl font-bold ${oc.color}`}>{oc.label}</div>
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Last checked: {new Date(health.checkedAt).toLocaleString()}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service) => {
              const sc = statusConfig[service.status];
              const Icon = sc.icon;
              return (
                <div key={service.name} className={`rounded-xl border ${sc.border} ${sc.bg} p-5`} data-testid={`health-service-${service.name}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon size={18} className={sc.color} />
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100 capitalize">{service.name}</h3>
                    </div>
                    <span className={`text-xs font-medium ${sc.color}`}>{sc.label}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-gray-600 dark:text-gray-400">
                    <span>Latency: {service.latencyMs}ms</span>
                  </div>
                  {service.message && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{service.message}</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
