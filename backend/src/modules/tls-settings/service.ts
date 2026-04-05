import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// ─── Defaults ────────────────────────────────────────────────────────────────

const ENV_CLUSTER_ISSUER = process.env.CLUSTER_ISSUER_NAME;

const DEFAULTS = {
  clusterIssuerName: ENV_CLUSTER_ISSUER ?? 'letsencrypt-production',
  autoTlsEnabled: true,
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getTlsSettings(db: Database) {
  const issuer = await getSetting(db, 'cluster_issuer_name');
  const autoTls = await getSetting(db, 'auto_tls_enabled');

  return {
    clusterIssuerName: issuer ?? DEFAULTS.clusterIssuerName,
    autoTlsEnabled: autoTls !== null ? autoTls === 'true' : DEFAULTS.autoTlsEnabled,
  };
}

export async function updateTlsSettings(
  db: Database,
  input: { clusterIssuerName?: string; autoTlsEnabled?: boolean },
) {
  if (input.clusterIssuerName !== undefined) {
    await setSetting(db, 'cluster_issuer_name', input.clusterIssuerName);
  }
  if (input.autoTlsEnabled !== undefined) {
    await setSetting(db, 'auto_tls_enabled', String(input.autoTlsEnabled));
  }

  return getTlsSettings(db);
}

/**
 * Get the ClusterIssuer name for cert-manager annotations.
 * Used by the k8s manifest generator and cert provisioning.
 */
export async function getClusterIssuerName(db: Database): Promise<string> {
  const settings = await getTlsSettings(db);
  return settings.clusterIssuerName;
}

/**
 * Check if automatic TLS via cert-manager is enabled.
 */
export async function isAutoTlsEnabled(db: Database): Promise<boolean> {
  const settings = await getTlsSettings(db);
  return settings.autoTlsEnabled;
}
