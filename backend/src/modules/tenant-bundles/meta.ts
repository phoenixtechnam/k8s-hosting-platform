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
 *
 * Legacy v1 bundles (captured before the schema bump on 2026-05-08)
 * are accepted on READ paths — the missing v2-only fields (`client`,
 * `domainsSummary`, `deploymentsSummary`) are filled with safe
 * defaults so verify / export / restore-cart continue to work for
 * pre-existing bundles. NEW captures always write v2; only the
 * IMPORT endpoint rejects v1 with `UNKNOWN_SCHEMA_VERSION` because
 * a cross-region import without v2 metadata can't reproduce the
 * client config (the whole point of v2).
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
  if (typeof sv !== 'number') {
    throw new BackupMetaError(
      'UNKNOWN_SCHEMA_VERSION',
      `meta.json missing or non-numeric schemaVersion (${String(sv)})`,
    );
  }
  // v1 = legacy capture without client/domains/deployments blocks.
  // v2 = current. Anything else is forward-incompatible.
  if (sv !== 1 && sv !== BACKUP_META_SCHEMA_VERSION) {
    throw new BackupMetaError(
      'UNKNOWN_SCHEMA_VERSION',
      `Unsupported meta.json schemaVersion ${String(sv)}; this platform supports 1 (legacy read-only) and ${BACKUP_META_SCHEMA_VERSION}`,
    );
  }

  // Promote v1 → v2 in-memory: fill the v2-only fields with `null`
  // (client) and empty arrays so downstream code can rely on the v2
  // shape. v1 bundles can be verified / exported / restored-via-cart
  // but cannot be IMPORTED to a new region (no client block to seed).
  const upgraded = sv === 1 ? upgradeV1ToV2(json as Record<string, unknown>) : json;

  const parsed = backupMetaV1Schema.safeParse(upgraded);
  if (!parsed.success) {
    throw new BackupMetaError('INVALID_META', parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

/**
 * Promote a v1 manifest to v2 in-memory. The v2-only fields default
 * to `null` (client) and `[]` (summaries) — sufficient for read paths
 * (verify / export / restore-via-cart). The IMPORT endpoint enforces
 * non-null `client` separately, so a v1-promoted manifest cannot
 * sneak through that path.
 */
function upgradeV1ToV2(v1: Record<string, unknown>): Record<string, unknown> {
  return {
    ...v1,
    schemaVersion: BACKUP_META_SCHEMA_VERSION,
    client: v1.client ?? null,
    domainsSummary: v1.domainsSummary ?? [],
    deploymentsSummary: v1.deploymentsSummary ?? [],
  };
}

/** Canonical filename for the manifest. */
export const META_FILENAME = 'meta.json';

/** Canonical component subdirectory name. */
export function componentDir(component: 'files' | 'mailboxes' | 'config' | 'secrets'): string {
  return `components/${component}`;
}
