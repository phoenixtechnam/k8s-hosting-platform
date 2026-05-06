/**
 * BackupStore — the only abstraction backend code uses to read/write
 * component-oriented backup bundles.
 *
 * See ADR-032 for the contract this interface locks down, and
 * docs/06-features/BACKUP_COMPONENT_MODEL.md for the bundle layout.
 *
 * Concrete implementations live next to this file:
 *   - local-hostpath-backup-store.ts  → 'hostpath'
 *   - s3-backup-store.ts              → 's3'
 *   - ssh-backup-store.ts             → 'ssh'
 *
 * Component capture code never opens sockets, files, or S3 clients
 * directly — it always goes through this interface so retention sweeps,
 * audits, and presigned downloads work uniformly across backends.
 */

import type { Readable } from 'node:stream';
import type { BackupComponentName, BackupMetaV1 } from '@k8s-hosting/api-contracts';

export type { BackupComponentName, BackupMetaV1 };

/**
 * Opaque per-bundle handle. Backends embed their own URI / prefix /
 * connection ref inside `bundleId` (and any private fields), and
 * callers MUST NOT inspect anything other than `bundleId`.
 */
export interface BundleHandle {
  readonly bundleId: string;
  /** Backend-private state. Treat as opaque from outside the store. */
  readonly _backend: Record<string, unknown>;
}

export interface ArtifactRef {
  readonly component: BackupComponentName;
  readonly name: string;
  /** Optional pre-known SHA-256 (lower-case hex). */
  readonly sha256?: string;
  readonly sizeBytes: number;
}

export interface ArtifactStat {
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

export interface WriteComponentOptions {
  readonly sha256?: string;
  /** Total expected bytes if known up-front (for S3 multipart sizing). */
  readonly contentLength?: number;
  /** MIME hint — affects S3 PUT but is not validated. */
  readonly contentType?: string;
}

export interface BackupStore {
  /** Backend kind — useful for logging and error attribution. */
  readonly kind: 'hostpath' | 's3' | 'ssh';

  /**
   * Reserve a new bundle directory. Idempotent on `(bundleId)`.
   * Implementations MUST NOT write meta.json yet — the bundle is
   * "in-flight" until {@link putMeta} is called.
   */
  reserveBundle(input: { backupId: string; clientId: string }): Promise<BundleHandle>;

  /**
   * Resolve a stored bundle by id. Returns `null` if the bundle has
   * not been reserved or has been deleted.
   *
   * Note: a non-null result does NOT imply meta.json exists yet — use
   * {@link getMeta} for that check.
   */
  open(backupId: string): Promise<BundleHandle | null>;

  /**
   * Stream a component artifact into the bundle.
   *
   * `name` must be the on-disk filename (e.g. `archive.tar.gz`,
   * `<addr>.mbox.tar.gz`, `db-rows.json.gz`, `tls.json.gz.enc`).
   *
   * Idempotent on `(bundleId, component, name)` — re-uploading the
   * same artifact overwrites in place. The implementation MUST NOT
   * leave a partial artifact visible if the upload aborts.
   */
  writeComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
    body: Readable,
    opts?: WriteComponentOptions,
  ): Promise<ArtifactRef>;

  /**
   * Open a component artifact for reading (used by restore flows).
   * Throws if the artifact is missing.
   */
  readComponent(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<Readable>;

  /**
   * Enumerate artifacts under one component. Used by restore code to
   * list mailboxes or to confirm a config dump exists.
   */
  listArtifacts(
    handle: BundleHandle,
    component: BackupComponentName,
  ): Promise<ArtifactRef[]>;

  /**
   * Stat one artifact without fetching its body. Returns `null` when
   * the artifact is missing.
   */
  stat(
    handle: BundleHandle,
    component: BackupComponentName,
    name: string,
  ): Promise<ArtifactStat | null>;

  /**
   * Write the canonical `meta.json`. MUST be the LAST step of capture —
   * the presence of meta.json is the bundle's commit marker
   * (ADR-032 §2). The implementation MUST write atomically (rename on
   * hostpath, single PUT on S3, atomic mv on SSH).
   */
  putMeta(handle: BundleHandle, meta: BackupMetaV1): Promise<void>;

  /**
   * Read meta.json. Throws on schemaVersion mismatch (per spec — never
   * silently downgrade old bundles).
   */
  getMeta(handle: BundleHandle): Promise<BackupMetaV1>;

  /** Delete the entire bundle (used by retention enforcement). */
  delete(handle: BundleHandle): Promise<void>;
}
