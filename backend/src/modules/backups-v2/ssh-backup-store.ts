/**
 * SshBackupStore — bundles laid out under a remote path on an
 * SSH-accessible host.
 *
 * Architecture (ADR-032 §5):
 *   The platform-api pod does NOT open outbound SSH connections — it
 *   would require carving SSH egress into the platform-api
 *   NetworkPolicy and would mount the long-lived SSH key into the
 *   long-lived backend pod.
 *
 *   Instead, every write/read goes through a short-lived k8s Job in
 *   the `platform-system` namespace that mounts the SSH key as a
 *   Secret and streams data via `tar | ssh user@host "cat > path"`.
 *
 * Status: STUB. The interface is shaped so the orchestrator can pick
 * an SSH target and the activation/test-draft flow can record the
 * configuration today, but `writeComponent`/`readComponent` are not
 * yet wired to the Job harness. Phase 3 of the backup roadmap fills
 * this in.
 *
 * Calls that don't require remote I/O (reserveBundle, open) succeed;
 * I/O calls throw a stable code so the API layer can surface a
 * structured OperatorError envelope.
 */

import type { Readable } from 'node:stream';
import type { BackupComponentName, BackupMetaV1 } from '@k8s-hosting/api-contracts';
import type {
  BackupStore,
  BundleHandle,
  ArtifactRef,
  ArtifactStat,
  WriteComponentOptions,
} from './bundle-store.js';

export interface SshBackupStoreConfig {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  /** Encrypted private key blob — decrypted by the orchestrator before
   *  mounting into the SSH Job's Secret. Never read in this process. */
  readonly encryptedPrivateKey: string;
  /** Absolute base path on the remote host. */
  readonly basePath: string;
}

class SshNotImplementedError extends Error {
  readonly code = 'SSH_BACKUP_NOT_IMPLEMENTED' as const;
  constructor(operation: string) {
    super(`SshBackupStore.${operation}: SSH backend is shipped as a stub; implementation pending Phase 3 of the backup roadmap (ADR-032 §5).`);
    this.name = 'SshNotImplementedError';
  }
}

interface SshBackend {
  readonly remotePath: string;
}

export class SshBackupStore implements BackupStore {
  readonly kind = 'ssh' as const;

  constructor(private readonly config: SshBackupStoreConfig) {}

  async reserveBundle(input: { backupId: string; clientId: string }): Promise<BundleHandle> {
    const remotePath = `${this.config.basePath.replace(/\/+$/, '')}/${input.backupId}`;
    return { bundleId: input.backupId, _backend: { remotePath } satisfies SshBackend };
  }

  async open(backupId: string): Promise<BundleHandle | null> {
    const remotePath = `${this.config.basePath.replace(/\/+$/, '')}/${backupId}`;
    return { bundleId: backupId, _backend: { remotePath } satisfies SshBackend };
  }

  async writeComponent(
    _handle: BundleHandle,
    _component: BackupComponentName,
    _name: string,
    _body: Readable,
    _opts?: WriteComponentOptions,
  ): Promise<ArtifactRef> {
    throw new SshNotImplementedError('writeComponent');
  }

  async readComponent(
    _handle: BundleHandle,
    _component: BackupComponentName,
    _name: string,
  ): Promise<Readable> {
    throw new SshNotImplementedError('readComponent');
  }

  async listArtifacts(
    _handle: BundleHandle,
    _component: BackupComponentName,
  ): Promise<ArtifactRef[]> {
    throw new SshNotImplementedError('listArtifacts');
  }

  async stat(
    _handle: BundleHandle,
    _component: BackupComponentName,
    _name: string,
  ): Promise<ArtifactStat | null> {
    throw new SshNotImplementedError('stat');
  }

  async putMeta(_handle: BundleHandle, _meta: BackupMetaV1): Promise<void> {
    throw new SshNotImplementedError('putMeta');
  }

  async getMeta(_handle: BundleHandle): Promise<BackupMetaV1> {
    throw new SshNotImplementedError('getMeta');
  }

  async delete(_handle: BundleHandle): Promise<void> {
    throw new SshNotImplementedError('delete');
  }
}
