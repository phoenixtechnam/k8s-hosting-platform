/**
 * meta.json reader/writer.
 *
 * Per ADR-032 §2 + BACKUP_COMPONENT_MODEL.md:
 *   - The presence of meta.json is the bundle's commit marker.
 *   - Restores MUST reject bundles with an unknown schemaVersion
 *     rather than guess at field semantics.
 *
 * This module is the only place where bundle JSON is parsed; every
 * BackupStore implementation defers the schema check here so a future
 * schemaVersion=2 only needs one branch.
 */

import {
  BACKUP_META_SCHEMA_VERSION,
  backupMetaV1Schema,
  type BackupMetaV1,
} from '@k8s-hosting/api-contracts';

export class BackupMetaError extends Error {
  readonly code: 'INVALID_JSON' | 'UNKNOWN_SCHEMA_VERSION' | 'INVALID_META';
  constructor(code: BackupMetaError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'BackupMetaError';
  }
}

/**
 * Serialize a meta.json payload. Always emits the current schema
 * version; callers should pass the exact object the store will write.
 */
export function serializeMeta(meta: BackupMetaV1): Buffer {
  // Validate before serializing so a buggy caller never writes a
  // malformed manifest to a long-lived store.
  const parsed = backupMetaV1Schema.parse(meta);
  return Buffer.from(JSON.stringify(parsed, null, 2), 'utf8');
}

/**
 * Parse a meta.json payload. Throws {@link BackupMetaError} with a
 * stable code on schemaVersion mismatch or shape violations so the
 * store layer can surface a structured OperatorError envelope.
 */
export function parseMeta(raw: Buffer | string): BackupMetaV1 {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new BackupMetaError('INVALID_JSON', `meta.json is not valid JSON: ${(err as Error).message}`);
  }

  // Check schemaVersion BEFORE running the full Zod parse so we give a
  // precise error code for forward-incompatible bundles.
  const sv = (json as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof sv !== 'number' || sv !== BACKUP_META_SCHEMA_VERSION) {
    throw new BackupMetaError(
      'UNKNOWN_SCHEMA_VERSION',
      `Unsupported meta.json schemaVersion ${String(sv)}; this platform supports ${BACKUP_META_SCHEMA_VERSION}`,
    );
  }

  const parsed = backupMetaV1Schema.safeParse(json);
  if (!parsed.success) {
    throw new BackupMetaError('INVALID_META', parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

/** Canonical filename for the manifest. */
export const META_FILENAME = 'meta.json';

/** Canonical component subdirectory name. */
export function componentDir(component: 'files' | 'mailboxes' | 'config' | 'secrets'): string {
  return `components/${component}`;
}
