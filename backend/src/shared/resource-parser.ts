/**
 * Parse Kubernetes resource values into normalized numbers.
 * CPU: "0.25" -> 0.25 cores, "250m" -> 0.25 cores, "4" -> 4 cores
 * Memory/Storage: "256Mi" -> 0.25 Gi, "1Gi" -> 1 Gi, "1024Ki" -> 0.001 Gi, "512" -> 0.000000476837 Gi
 */
export function parseResourceValue(value: string, unit: 'cpu' | 'memory' | 'storage'): number {
  const trimmed = value.trim();

  if (unit === 'cpu') {
    if (trimmed.endsWith('m')) return Number(trimmed.slice(0, -1)) / 1000;
    return Number(trimmed);
  }

  // Memory/Storage: normalize to Gi
  if (trimmed.endsWith('Gi')) return Number(trimmed.slice(0, -2));
  if (trimmed.endsWith('Mi')) return Number(trimmed.slice(0, -2)) / 1024;
  if (trimmed.endsWith('Ki')) return Number(trimmed.slice(0, -2)) / (1024 * 1024);
  return Number(trimmed) / (1024 * 1024 * 1024); // raw bytes -> Gi
}
