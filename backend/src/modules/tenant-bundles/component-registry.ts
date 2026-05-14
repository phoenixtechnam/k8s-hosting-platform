/**
 * BundleComponent registry — declares which tenant data dimensions
 * each component owns. The schema-audit + resource-audit scripts
 * (Phase A) plus the operator coverage UI (Phase D) consume this
 * registry to detect drift between "what exists for a tenant" vs
 * "what the bundle would capture".
 *
 * Adding a new tenant data dimension:
 *   1. Create or extend a component under tenant-bundles/components/.
 *   2. Have it export a `componentOwnership: ComponentOwnership`
 *      object describing what it claims (DB tables, PVC name patterns,
 *      Secret types/names).
 *   3. Add it to BUNDLE_COMPONENTS below.
 *   4. The CI audits + the GET /admin/tenant-bundles/coverage
 *      endpoint will pick it up automatically.
 */

import type { BackupComponentName } from '@k8s-hosting/api-contracts';

export interface ComponentOwnership {
  /**
   * The component's stable name. Matches the BackupComponentName
   * enum so it can be cross-referenced with bundle metadata.
   */
  readonly name: BackupComponentName;

  /**
   * Human-readable description for the operator coverage UI.
   */
  readonly description: string;

  /**
   * DB tables (camelCase, matching the keys in CONFIG_DUMP_TABLES)
   * that this component captures. Empty if the component has no DB
   * footprint.
   */
  readonly tables: ReadonlyArray<string>;

  /**
   * PVC names (or `${namespace}-storage`-style templates) that this
   * component captures. The `{ns}` placeholder is replaced at audit
   * time with the actual tenant namespace.
   */
  readonly pvcs: ReadonlyArray<string>;

  /**
   * K8s Secret types or selectors that this component captures.
   * `kubernetes.io/tls` is the standard TLS-typed Secret. Use the
   * full type string (e.g. `Opaque`) for non-TLS captures.
   */
  readonly secretTypes: ReadonlyArray<string>;

  /**
   * External (non-k8s) resources this component captures, for
   * documentation purposes only. Examples: Stalwart mailboxes via
   * IMAP, Postgres rows reached via direct DB connection, S3 buckets.
   */
  readonly externalResources: ReadonlyArray<string>;
}

/**
 * Canonical registry of every shipping bundle component. Synced
 * with the per-component declarations in
 * tenant-bundles/components/*.ts (each file exports a
 * `componentOwnership` const).
 *
 * NOTE: kept as a literal array (not auto-discovered) because the
 * audit scripts and the coverage API both need a deterministic
 * snapshot of declared coverage at static-analysis time.
 */
export const BUNDLE_COMPONENTS: ReadonlyArray<ComponentOwnership> = [
  {
    name: 'files',
    description:
      'Tenant data PVC contents — every file under the canonical `${namespace}-storage` mount, captured as a streamed tar.gz.',
    tables: [],
    pvcs: ['{ns}-storage'],
    secretTypes: [],
    externalResources: [],
  },
  {
    name: 'mailboxes',
    description:
      'Per-mailbox Maildir tarballs captured via IMAP master-user proxy. Mail content is stored in Stalwart\'s Postgres cluster + reached over IMAPS:993.',
    tables: [],
    pvcs: [],
    secretTypes: [],
    externalResources: [
      'Stalwart IMAP (stalwart-mail.mail.svc.cluster.local:993)',
    ],
  },
  {
    name: 'config',
    description:
      'JSON Lines dump of every row in CONFIG_DUMP_TABLES filtered by clientId. Restore replays via INSERT…ON CONFLICT…DO UPDATE.',
    // Mirrors backend/src/modules/tenant-bundles/components/config.ts:CONFIG_DUMP_TABLES.
    // The schema-audit script asserts this list stays in sync with that file.
    tables: [
      'clients',
      'users',
      'domains',
      'emailDomains',
      'mailboxes',
      'emailAliases',
      'mailSubmitCredentials',
      'sshKeys',
      'sftpUsers',
      'deployments',
      'ingressAuthConfigs',
      'sslCertificates',
      'cronJobs',
      'resourceQuotas',
      'clientOidcProviders',
      'clientMtlsProviders',
      'clientZitiProviders',
      'clientZrokAccounts',
    ],
    pvcs: [],
    secretTypes: [],
    externalResources: [],
  },
  {
    name: 'secrets',
    description:
      'Every kubernetes.io/tls Secret in the tenant namespace, encrypted with AES-256-GCM (KID `k1:` prefix) using PLATFORM_ENCRYPTION_KEY.',
    tables: [],
    pvcs: [],
    secretTypes: ['kubernetes.io/tls'],
    externalResources: [],
  },
];

/**
 * Reverse lookup: which component, if any, claims this DB table?
 * Used by the schema-audit and coverage UI to detect orphans.
 */
export function ownerOfTable(table: string): ComponentOwnership | null {
  return BUNDLE_COMPONENTS.find((c) => c.tables.includes(table)) ?? null;
}

/**
 * Reverse lookup: which component captures this Secret type?
 */
export function ownerOfSecretType(type: string): ComponentOwnership | null {
  return BUNDLE_COMPONENTS.find((c) => c.secretTypes.includes(type)) ?? null;
}

/**
 * Reverse lookup: which component captures this PVC name template?
 * The `pvcName` may be a literal name (`abc-storage`) or a template
 * (`{ns}-storage`); the comparison strips the namespace prefix.
 */
export function ownerOfPvc(pvcName: string, namespace: string): ComponentOwnership | null {
  const stripped = pvcName.replace(`${namespace}-`, '{ns}-');
  return BUNDLE_COMPONENTS.find(
    (c) =>
      c.pvcs.includes(pvcName) ||
      c.pvcs.some((tmpl) => tmpl.replace('{ns}', namespace) === pvcName) ||
      c.pvcs.includes(stripped),
  ) ?? null;
}
