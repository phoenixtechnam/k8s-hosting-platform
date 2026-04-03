import { useEffect } from 'react';
import { CheckCircle, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { useResourceAvailability } from '@/hooks/use-resource-availability';

interface ResourceRequirementCheckProps {
  readonly minimumCpu?: string;
  readonly minimumMemory?: string;
  readonly minimumStorage?: string;
  readonly onFitsChange?: (fits: boolean) => void;
}

function parseCpu(value: string): number {
  if (value.endsWith('m')) return Number(value.slice(0, -1)) / 1000;
  return Number(value) || 0;
}

function parseMemoryGi(value: string): number {
  if (value.endsWith('Gi')) return Number(value.slice(0, -2));
  if (value.endsWith('Mi')) return Number(value.slice(0, -2)) / 1024;
  return Number(value) || 0;
}

function parseStorageGi(value: string): number {
  if (value.endsWith('Gi')) return Number(value.slice(0, -2));
  if (value.endsWith('Mi')) return Number(value.slice(0, -2)) / 1024;
  return Number(value) || 0;
}

interface ResourceRow {
  readonly label: string;
  readonly available: number;
  readonly required: number;
  readonly unit: string;
  readonly fits: boolean;
}

function formatValue(value: number, unit: string): string {
  if (unit === 'cores') return `${value.toFixed(2)} ${unit}`;
  return `${value.toFixed(2)} Gi`;
}

export default function ResourceRequirementCheck({
  minimumCpu,
  minimumMemory,
  minimumStorage,
  onFitsChange,
}: ResourceRequirementCheckProps) {
  const { clientId } = useClientContext();
  const { data, isLoading, isError } = useResourceAvailability(clientId ?? undefined);

  const availability = data?.data;

  const rows: readonly ResourceRow[] = (() => {
    if (!availability) return [];
    const result: ResourceRow[] = [];

    if (minimumCpu) {
      const required = parseCpu(minimumCpu);
      const available = availability.cpuAvailable;
      result.push({ label: 'CPU', available, required, unit: 'cores', fits: available >= required });
    }
    if (minimumMemory) {
      const required = parseMemoryGi(minimumMemory);
      const available = availability.memoryAvailableGi;
      result.push({ label: 'Memory', available, required, unit: 'Gi', fits: available >= required });
    }
    if (minimumStorage) {
      const required = parseStorageGi(minimumStorage);
      const available = availability.storageAvailableGi;
      result.push({ label: 'Storage', available, required, unit: 'Gi', fits: available >= required });
    }
    return result;
  })();

  const allFit = rows.length === 0 || rows.every(r => r.fits);

  useEffect(() => {
    if (!isLoading && !isError && onFitsChange) {
      onFitsChange(allFit);
    }
  }, [allFit, isLoading, isError, onFitsChange]);

  // Permissive on error: allow deploy
  useEffect(() => {
    if (isError && onFitsChange) {
      onFitsChange(true);
    }
  }, [isError, onFitsChange]);

  // Don't render if no requirements specified
  if (!minimumCpu && !minimumMemory && !minimumStorage) {
    return null;
  }

  return (
    <div
      className="rounded-lg border border-gray-200 dark:border-gray-700 p-4"
      data-testid="resource-requirement-check"
    >
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
        Resource Requirements
      </h4>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          <span>Checking resource availability...</span>
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} />
          <span>Unable to check resource availability. You may proceed with deployment.</span>
        </div>
      )}

      {!isLoading && !isError && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(row => (
            <div key={row.label} className="flex items-center gap-2 text-sm">
              {row.fits ? (
                <CheckCircle size={16} className="shrink-0 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle size={16} className="shrink-0 text-red-600 dark:text-red-400" />
              )}
              <span className={row.fits ? 'text-gray-700 dark:text-gray-300' : 'text-red-600 dark:text-red-400'}>
                {row.label}: {formatValue(row.available, row.unit)} available ({formatValue(row.required, row.unit)} required)
                {!row.fits && <span className="font-medium"> — Insufficient</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
