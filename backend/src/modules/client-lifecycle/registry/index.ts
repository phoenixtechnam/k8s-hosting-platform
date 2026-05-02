export {
  type Transition,
  type HookCtx,
  type HookResult,
  type HookResultStatus,
  type HookErrorEnvelope,
  type LifecycleHook,
  type BlockingPolicy,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
} from './types.js';

export {
  registerLifecycleHook,
  listHooks,
  topoSortForTransition,
  LifecycleRegistryError,
  _resetRegistryForTests,
} from './registry.js';

export {
  runTransition,
  type DispatchOptions,
  type DispatchResult,
} from './dispatcher.js';
