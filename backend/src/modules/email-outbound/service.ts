/**
 * Outbound email reconciler — Phase 3.B.1 + B.3.
 *
 * Reads smtp_relay_configs + per-client rate limits from the DB and
 * writes a Stalwart TOML fragment into a Kubernetes ConfigMap in the
 * `mail` namespace. Triggers Stalwart to reload via a config-change
 * annotation on the StatefulSet pod template (which causes a
 * controlled rolling update).
 *
 * Called:
 *   - on smtp_relay_configs CRUD (create / update / delete)
 *   - on client status change (suspend / unsuspend)
 *   - on client rate-limit update
 *   - on platform-settings default rate limit change
 *   - manually via POST /api/v1/admin/mail/outbound/reconcile
 */

import { eq } from 'drizzle-orm';
import { clients, smtpRelayConfigs, platformSettings } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import {
  renderQueueOutboundToml,
  renderQueueThrottleToml,
  type OutboundRelay,
  type ClientThrottleOverride,
} from './renderer.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MAIL_NAMESPACE = 'mail';
const OUTBOUND_CONFIGMAP_NAME = 'stalwart-outbound-config';

export interface OutboundReconcileLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: OutboundReconcileLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface ReconcileOutboundResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly configMapName?: string;
  readonly relaysConfigured?: number;
  readonly overridesConfigured?: number;
}

/**
 * Build the outbound+throttle TOML from the current DB state.
 */
export async function renderCurrentOutboundConfig(
  db: Database,
): Promise<{ outbound: string; throttle: string }> {
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);

  // Load and decrypt relays
  const relayRows = await db.select().from(smtpRelayConfigs);
  const relays: OutboundRelay[] = relayRows.map((row) => {
    // Decrypt password (auth_password_encrypted) or api_key_encrypted
    let password: string | null = null;
    if (row.authPasswordEncrypted) {
      try {
        password = decrypt(row.authPasswordEncrypted, encryptionKey);
      } catch {
        password = null;
      }
    } else if (row.apiKeyEncrypted) {
      try {
        password = decrypt(row.apiKeyEncrypted, encryptionKey);
      } catch {
        password = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      providerType: row.providerType,
      isDefault: row.isDefault,
      enabled: row.enabled,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      authUsername: row.authUsername,
      authPassword: password,
    };
  });

  // Load default rate limit from platform settings
  const [defaultRow] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, 'email_send_rate_limit_default'));
  const defaultRateLimit = defaultRow?.value ? parseInt(defaultRow.value, 10) : null;

  // Load client overrides (any client with non-null email_send_rate_limit
  // OR status='suspended')
  const clientRows = await db.select().from(clients);
  const overrides: ClientThrottleOverride[] = clientRows
    .filter((c) => c.emailSendRateLimit !== null || c.status === 'suspended')
    .map((c) => ({
      clientId: c.id,
      rateLimit: c.emailSendRateLimit ?? null,
      suspended: c.status === 'suspended',
    }));

  const outbound = renderQueueOutboundToml({ relays });
  const throttle = renderQueueThrottleToml({
    defaultRateLimit: Number.isFinite(defaultRateLimit) ? defaultRateLimit : null,
    clientOverrides: overrides,
  });

  return { outbound, throttle };
}

function k8sStatusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number }; code?: number };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.statusCode === 'number') return e.response.statusCode;
  if (typeof e?.code === 'number') return e.code;
  return undefined;
}

/**
 * Write the rendered TOML into a ConfigMap in the `mail` namespace.
 *
 * Operators mount this ConfigMap into the Stalwart pod as an
 * additional config file via a production overlay patch. Stalwart's
 * config include syntax (or a simple concatenation at pod init time)
 * combines it with the base config.
 *
 * For local dev we just write the ConfigMap. The operator-facing
 * integration comes in the production overlay (follow-up).
 */
export async function reconcileOutboundConfig(
  db: Database,
  k8s: K8sClients | undefined,
  logger: OutboundReconcileLogger = noopLogger,
): Promise<ReconcileOutboundResult> {
  if (!k8s) {
    logger.warn({}, 'reconcileOutboundConfig: no k8s client, skipping');
    return { skipped: true, reason: 'no k8s client' };
  }

  const { outbound, throttle } = await renderCurrentOutboundConfig(db);
  const combinedToml = `${outbound}\n${throttle}\n`;

  const body = {
    metadata: {
      name: OUTBOUND_CONFIGMAP_NAME,
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'stalwart-outbound-config',
        'app.kubernetes.io/managed-by': 'k8s-hosting-platform',
      },
      annotations: {
        'k8s-hosting-platform/rendered-at': new Date().toISOString(),
      },
    },
    data: {
      'outbound.toml': combinedToml,
    },
  };

  try {
    await k8s.core.createNamespacedConfigMap({
      namespace: MAIL_NAMESPACE,
      body,
    });
  } catch (err) {
    if (k8sStatusCode(err) === 409) {
      await k8s.core.replaceNamespacedConfigMap({
        name: OUTBOUND_CONFIGMAP_NAME,
        namespace: MAIL_NAMESPACE,
        body,
      });
    } else {
      logger.error({ err }, 'reconcileOutboundConfig: ConfigMap write failed');
      throw err;
    }
  }

  // Count enabled relays and overrides for the return value
  const relayRows = await db.select().from(smtpRelayConfigs);
  const enabledRelays = relayRows.filter((r) => r.enabled === 1).length;
  const clientRows = await db.select().from(clients);
  const overrideCount = clientRows.filter(
    (c) => c.emailSendRateLimit !== null || c.status === 'suspended',
  ).length;

  logger.info(
    { relays: enabledRelays, overrides: overrideCount },
    'reconcileOutboundConfig: Stalwart outbound ConfigMap updated',
  );

  return {
    skipped: false,
    configMapName: OUTBOUND_CONFIGMAP_NAME,
    relaysConfigured: enabledRelays,
    overridesConfigured: overrideCount,
  };
}
