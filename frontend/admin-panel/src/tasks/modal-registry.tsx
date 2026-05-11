// Task target modal registry.
//
// `TaskTarget.modal` is a string key into this registry. Adding a new
// task kind that opens a modal requires touching this file (intended
// friction — the chip stays free of per-kind switch statements).

import { lazy, Suspense, type ComponentType } from 'react';

interface ModalCloseProps {
  readonly onClose: () => void;
}

interface RegistryEntry {
  readonly Component: ComponentType<Record<string, unknown> & ModalCloseProps>;
}

const TransitionProgressModal = lazy(() => import('@/components/TransitionProgressModal'));
const BulkProgressModal = lazy(() => import('@/components/BulkProgressModal'));
const OperationProgressModal = lazy(() => import('@/components/OperationProgressModal'));
const ProvisioningProgressModal = lazy(() => import('@/components/ProvisioningProgressModal'));
const ApplyHaProgressModal = lazy(() => import('@/components/ApplyHaProgressModal'));

// Registry: modal key (matches `TaskTarget.modal`) → component. The
// chip wraps the rendered component in <Suspense> so the lazy import
// doesn't block the chip click handler.
//
// Each entry below corresponds to one or more `kind` values on the
// task row. The backend chooses `target.modal = 'foo'` and supplies
// the matching `target.modalProps` shape:
//
//   transition            → TransitionProgressModal     (client.transition)
//   bulk                  → BulkProgressModal           (client.*.bulk)
//   operation             → OperationProgressModal      (storage.*)
//   provisioning          → ProvisioningProgressModal   (client.provision)
//   platform-storage-apply→ ApplyHaProgressModal        (storage.tier-flip)
//
// Surfaces without a dedicated modal use `target.type = 'route'`
// instead.
const REGISTRY: Record<string, RegistryEntry> = {
  transition: {
    Component: TransitionProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  bulk: {
    Component: BulkProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  operation: {
    Component: OperationProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  provisioning: {
    Component: ProvisioningProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'platform-storage-apply': {
    Component: ApplyHaProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
};

interface TaskModalHostProps {
  readonly modal: string;
  readonly props: Record<string, unknown>;
  readonly onClose: () => void;
}

/**
 * Lookup + render the modal that matches `target.modal`. Unknown keys
 * render nothing (and log a console warning) so a missing registry
 * entry doesn't crash the chip.
 */
export function TaskModalHost({ modal, props, onClose }: TaskModalHostProps) {
  const entry = REGISTRY[modal];
  if (!entry) {
    if (typeof console !== 'undefined') {
      console.warn(`[task-center] no modal registered for key "${modal}"`);
    }
    return null;
  }
  const { Component } = entry;
  return (
    <Suspense fallback={null}>
      <Component {...props} onClose={onClose} />
    </Suspense>
  );
}
