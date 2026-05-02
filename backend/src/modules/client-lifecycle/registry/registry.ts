import type { LifecycleHook, Transition } from './types.js';

/**
 * Process-global registry of lifecycle hooks. Modules call
 * `registerLifecycleHook` once at module load (typically alongside the
 * module's routes registration so reviewers can grep
 * `registerLifecycleHook` and confirm coverage of every transition).
 *
 * Phase 1: empty registry, dispatcher is a no-op log.
 * Phase 2-N: each hook ships behind a feature flag that flips the
 * matching legacy code path to no-op once the hook is authoritative.
 */
const hooks = new Map<string, LifecycleHook>();

export class LifecycleRegistryError extends Error {
  readonly code: 'DUPLICATE_NAME' | 'CYCLIC_AFTER' | 'UNKNOWN_AFTER' | 'INVALID_HOOK';
  constructor(code: LifecycleRegistryError['code'], message: string) {
    super(message);
    this.name = 'LifecycleRegistryError';
    this.code = code;
  }
}

function validateHook(hook: LifecycleHook): void {
  if (!hook.name || hook.name.length > 64) {
    throw new LifecycleRegistryError(
      'INVALID_HOOK',
      `hook.name must be 1..64 chars (got ${hook.name?.length ?? 0})`,
    );
  }
  if (!Number.isFinite(hook.order)) {
    throw new LifecycleRegistryError(
      'INVALID_HOOK',
      `hook.order must be finite (got ${String(hook.order)})`,
    );
  }
  if (hook.transitions.length === 0) {
    throw new LifecycleRegistryError(
      'INVALID_HOOK',
      `hook '${hook.name}' must declare at least one transition`,
    );
  }
  if (hook.blocking !== 'abort' && hook.blocking !== 'continue') {
    throw new LifecycleRegistryError(
      'INVALID_HOOK',
      `hook '${hook.name}' has invalid blocking policy '${String(hook.blocking)}'`,
    );
  }
}

/**
 * Add a hook to the registry. Throws on duplicate name. Idempotency:
 * re-registering the SAME hook reference is a noop (catches double-import
 * via ESM module caching corner cases). Re-registering a different hook
 * with the same name throws — that's almost always a bug.
 */
export function registerLifecycleHook(hook: LifecycleHook): void {
  validateHook(hook);
  const existing = hooks.get(hook.name);
  if (existing) {
    if (existing === hook) return;
    throw new LifecycleRegistryError(
      'DUPLICATE_NAME',
      `lifecycle hook '${hook.name}' is already registered with a different definition`,
    );
  }
  hooks.set(hook.name, hook);
}

/** Test-only: drop everything. Production code MUST NOT call this. */
export function _resetRegistryForTests(): void {
  hooks.clear();
}

export function listHooks(): readonly LifecycleHook[] {
  return Array.from(hooks.values());
}

/**
 * Topological sort of hooks for one transition.
 *
 * Primary key: `order` ascending.
 * Secondary key: `after` constraints (Kahn's algorithm over the subset).
 *
 * Rationale: `order` is the human-readable knob (review-friendly), `after`
 * is the explicit dependency declaration. We resolve them both — `order`
 * gives a stable initial ordering, then we apply Kahn to enforce `after`
 * edges. If `after` references a hook NOT in this transition's set, we
 * throw — silently ignoring it would mask copy-paste bugs.
 *
 * Cycle detection: a non-empty remainder after Kahn means a cycle.
 */
export function topoSortForTransition(
  transition: Transition,
  all: readonly LifecycleHook[] = listHooks(),
): readonly LifecycleHook[] {
  const subset = all.filter((h) => h.transitions.includes(transition));
  // Stable sort by order first.
  const byOrder = subset.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // Build adjacency for `after`. Each edge `a after b` means b must come before a.
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const inSubset = new Set(byOrder.map((h) => h.name));
  for (const h of byOrder) {
    inDegree.set(h.name, 0);
    adj.set(h.name, []);
  }
  for (const h of byOrder) {
    for (const dep of h.after ?? []) {
      if (!inSubset.has(dep)) {
        throw new LifecycleRegistryError(
          'UNKNOWN_AFTER',
          `hook '${h.name}' declares after '${dep}' but '${dep}' isn't registered for transition '${transition}'`,
        );
      }
      adj.get(dep)!.push(h.name);
      inDegree.set(h.name, (inDegree.get(h.name) ?? 0) + 1);
    }
  }

  // Kahn: pick a deterministic starting set — among nodes with inDegree 0,
  // honour the `order` precedence so the output is reproducible.
  const ready: string[] = byOrder
    .filter((h) => (inDegree.get(h.name) ?? 0) === 0)
    .map((h) => h.name);
  const out: LifecycleHook[] = [];
  const byName = new Map(byOrder.map((h) => [h.name, h]));
  while (ready.length > 0) {
    // Take the lowest-order ready node so the visible ordering tracks
    // `order` whenever `after` doesn't force otherwise.
    ready.sort((a, b) => {
      const ha = byName.get(a)!;
      const hb = byName.get(b)!;
      return ha.order - hb.order || ha.name.localeCompare(hb.name);
    });
    const next = ready.shift()!;
    out.push(byName.get(next)!);
    for (const succ of adj.get(next) ?? []) {
      inDegree.set(succ, (inDegree.get(succ) ?? 0) - 1);
      if (inDegree.get(succ) === 0) ready.push(succ);
    }
  }
  if (out.length !== byOrder.length) {
    const remaining = byOrder.map((h) => h.name).filter((n) => !out.find((h) => h.name === n));
    throw new LifecycleRegistryError(
      'CYCLIC_AFTER',
      `cycle in lifecycle hook 'after' graph for transition '${transition}': ${remaining.join(', ')}`,
    );
  }
  return out;
}
