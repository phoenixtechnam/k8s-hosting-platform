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

// Registry: modal key (matches `TaskTarget.modal`) → component. The
// chip wraps the rendered component in <Suspense> so the lazy import
// doesn't block the chip click handler.
const REGISTRY: Record<string, RegistryEntry> = {
  transition: {
    Component: TransitionProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  bulk: {
    Component: BulkProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
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
