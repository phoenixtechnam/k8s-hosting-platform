/**
 * Resource allocator for multi-component deployments.
 *
 * The user assigns a deployment a single `cpu_request` and `memory_request`
 * that represents the TOTAL budget for the whole stack. This module splits
 * the total across components by manifest-declared weights, honouring
 * per-component minimum floors.
 *
 * Job-type components and any component with a hard-pinned `resources`
 * block are NOT part of the shared budget — they keep their explicit
 * resources and the caller short-circuits the allocator for them.
 *
 * Outputs are always normalised: CPU in millicores ("250m"), memory in
 * mebibytes ("256Mi"). This makes summation in tests and quota-math
 * deterministic.
 */

import { parseResourceValue } from '../../shared/resource-parser.js';

export interface ResourceShare {
  readonly weight: number;
  readonly minCpu?: string;
  readonly minMemory?: string;
}

export interface AllocatorComponentInput {
  readonly name: string;
  readonly type?: 'deployment' | 'statefulset' | 'cronjob' | 'job';
  readonly resourceShare?: ResourceShare;
  /**
   * Hard-pinned per-component resources (one-shot install Jobs, etc.).
   * When set, the component is excluded from the shared budget and its
   * declared values are used verbatim by the caller.
   */
  readonly resources?: { readonly cpu?: string; readonly memory?: string };
}

export interface AllocationResult {
  readonly cpu: string;     // millicores, e.g. "250m"
  readonly memory: string;  // mebibytes,  e.g. "256Mi"
}

export interface AllocationOptions {
  readonly defaultMinCpu?: string;
  readonly defaultMinMemory?: string;
}

const DEFAULT_MIN_CPU = '50m';
const DEFAULT_MIN_MEMORY = '64Mi';

export interface PerComponentMinimum {
  readonly name: string;
  readonly cpu: string;
  readonly memory: string;
}

export class InsufficientResourceBudgetError extends Error {
  readonly code = 'INSUFFICIENT_RESOURCE_BUDGET';
  constructor(
    public readonly required: { cpu: string; memory: string },
    public readonly assigned: { cpu: string; memory: string },
    public readonly perComponentMinimums: readonly PerComponentMinimum[],
  ) {
    super(
      `Assigned budget (cpu=${assigned.cpu}, memory=${assigned.memory}) is below ` +
      `the sum of component minimums (cpu=${required.cpu}, memory=${required.memory}). ` +
      `Raise the deployment's CPU or memory.`,
    );
    this.name = 'InsufficientResourceBudgetError';
  }
}

export function allocateResources(
  total: { readonly cpu: string; readonly memory: string },
  components: readonly AllocatorComponentInput[],
  options: AllocationOptions = {},
): Map<string, AllocationResult> {
  const defaultMinCpu = options.defaultMinCpu ?? DEFAULT_MIN_CPU;
  const defaultMinMemory = options.defaultMinMemory ?? DEFAULT_MIN_MEMORY;

  // Hard-pinned components (Jobs, or any component with explicit resources)
  // sit outside the budget. The caller renders their declared values
  // unchanged; the allocator's job is only to split the remaining budget
  // across "budget-bearing" components.
  const budgetComponents = components.filter(
    (c) => c.type !== 'job'
      && (!c.resources || (c.resources.cpu === undefined && c.resources.memory === undefined)),
  );

  const out = new Map<string, AllocationResult>();
  if (budgetComponents.length === 0) {
    return out;
  }

  // Single component takes the full budget regardless of any declared share.
  if (budgetComponents.length === 1) {
    out.set(budgetComponents[0].name, {
      cpu: formatCpuMilli(toCpuMilli(total.cpu)),
      memory: formatMemMi(toMemMi(total.memory)),
    });
    return out;
  }

  const totalCpuMilli = toCpuMilli(total.cpu);
  const totalMemMi = toMemMi(total.memory);

  // All-or-nothing weights: only honour declared shares when every
  // budget-bearing component declares one. Partial declarations are
  // ignored and the allocator falls back to even split — sync-time
  // validation rejects partial manifests anyway, this is defence-in-depth.
  const useShares = budgetComponents.every((c) => c.resourceShare !== undefined);

  type CompSpec = {
    readonly name: string;
    readonly weight: number;
    readonly minCpuMilli: number;
    readonly minMemMi: number;
  };

  const specs: CompSpec[] = budgetComponents.map((c) => ({
    name: c.name,
    weight: useShares ? (c.resourceShare?.weight ?? 1) : 1,
    minCpuMilli: toCpuMilli(c.resourceShare?.minCpu ?? defaultMinCpu),
    minMemMi: toMemMi(c.resourceShare?.minMemory ?? defaultMinMemory),
  }));

  const sumMinCpu = specs.reduce((acc, s) => acc + s.minCpuMilli, 0);
  const sumMinMem = specs.reduce((acc, s) => acc + s.minMemMi, 0);
  if (sumMinCpu > totalCpuMilli || sumMinMem > totalMemMi) {
    throw new InsufficientResourceBudgetError(
      { cpu: formatCpuMilli(sumMinCpu), memory: formatMemMi(sumMinMem) },
      { cpu: formatCpuMilli(totalCpuMilli), memory: formatMemMi(totalMemMi) },
      specs.map((s) => ({
        name: s.name,
        cpu: formatCpuMilli(s.minCpuMilli),
        memory: formatMemMi(s.minMemMi),
      })),
    );
  }

  const totalWeight = specs.reduce((acc, s) => acc + s.weight, 0);

  // Minimum-first allocation: every component is guaranteed its minimum.
  // The remaining budget is then distributed by weight. This makes the
  // allocator stable under floor-enforcement (a tiny component being
  // floored up to its minimum doesn't overshoot the total).
  const cpuRemaining = totalCpuMilli - sumMinCpu;
  const memRemaining = totalMemMi - sumMinMem;

  const cpuAlloc = new Map<string, number>();
  const memAlloc = new Map<string, number>();
  let sumCpu = 0;
  let sumMem = 0;
  for (const s of specs) {
    const cpu = s.minCpuMilli + Math.floor((cpuRemaining * s.weight) / totalWeight);
    const mem = s.minMemMi + Math.floor((memRemaining * s.weight) / totalWeight);
    cpuAlloc.set(s.name, cpu);
    memAlloc.set(s.name, mem);
    sumCpu += cpu;
    sumMem += mem;
  }

  // Distribute the rounding remainder to the highest-weight component
  // (deterministic tiebreak by name). After minimum-first allocation the
  // remainder is always non-negative and ≤ component count.
  const cpuRemainder = totalCpuMilli - sumCpu;
  const memRemainder = totalMemMi - sumMem;
  if (cpuRemainder > 0 || memRemainder > 0) {
    const target = specs.slice().sort(
      (a, b) => b.weight - a.weight || a.name.localeCompare(b.name),
    )[0];
    cpuAlloc.set(target.name, (cpuAlloc.get(target.name) ?? 0) + cpuRemainder);
    memAlloc.set(target.name, (memAlloc.get(target.name) ?? 0) + memRemainder);
  }

  for (const s of specs) {
    out.set(s.name, {
      cpu: formatCpuMilli(cpuAlloc.get(s.name) ?? 0),
      memory: formatMemMi(memAlloc.get(s.name) ?? 0),
    });
  }
  return out;
}

function toCpuMilli(value: string): number {
  return Math.round(parseResourceValue(value, 'cpu') * 1000);
}

function toMemMi(value: string): number {
  return Math.round(parseResourceValue(value, 'memory') * 1024);
}

function formatCpuMilli(milli: number): string {
  return `${milli}m`;
}

function formatMemMi(mi: number): string {
  return `${mi}Mi`;
}
