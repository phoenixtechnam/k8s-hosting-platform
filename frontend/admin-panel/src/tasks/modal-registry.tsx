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
// 2026-05-16: long-running mail ops registered with the task center.
// `mail-operation` is the generic kind for port-exposure flips +
// snapshot triggers (one-page lifecycle visible via task chip).
// `mail-migration` reuses the dedicated migration modal that already
// polls /admin/mail/migrate/:runId (per-step state machine UI).
const MailTaskProgressModal = lazy(() => import('@/components/MailTaskProgressModal'));
const MailMigrationProgressModal = lazy(() => import('@/components/MailMigrationProgressModal'));
// 2026-05-17: Phase 10 of snapshot-storage overhaul. Speedtest is a
// platform-scoped op (NOT tenant-scoped) — modal polls /me/tasks +
// /admin/backup-configs for the latest result.
const SpeedtestProgressModal = lazy(() => import('@/components/SpeedtestProgressModal'));

// Registry: modal key (matches `TaskTarget.modal`) → component. The
// chip wraps the rendered component in <Suspense> so the lazy import
// doesn't block the chip click handler.
//
// Each entry below corresponds to one or more `kind` values on the
// task row. The backend chooses `target.modal = 'foo'` and supplies
// the matching `target.modalProps` shape:
//
//   transition            → TransitionProgressModal     (tenant.transition)
//   bulk                  → BulkProgressModal           (tenant.*.bulk)
//   operation             → OperationProgressModal      (storage.*)
//   provisioning          → ProvisioningProgressModal   (tenant.provision)
//   platform-storage-apply→ ApplyHaProgressModal        (storage.tier-flip)
//   mail-operation        → MailTaskProgressModal       (mail.port-exposure, mail.snapshot.trigger)
//   mail-migration        → MailMigrationProgressModal  (mail.migration)
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
  'mail-operation': {
    Component: MailTaskProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'mail-migration': {
    Component: MailMigrationProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
  },
  'backup-speedtest': {
    Component: SpeedtestProgressModal as unknown as ComponentType<Record<string, unknown> & ModalCloseProps>,
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
