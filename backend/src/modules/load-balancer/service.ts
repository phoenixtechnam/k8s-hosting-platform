import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { platformSettings, clusterNodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { type LoadBalancerProviderName, pickProvider } from './provider.js';

// M11: provider-abstracted Load Balancer. Opt-in via platform_settings
// (operator toggles in the admin UI). Activation is gated on a
// server-count check so a 1-server cluster doesn't accidentally pay
// for an LB that only points at a single backend.

const HA_GATE_MIN_SERVERS = 3;

const SETTINGS_KEY_ENABLED = 'load_balancer.enabled';
const SETTINGS_KEY_PROVIDER = 'load_balancer.provider';
const SETTINGS_KEY_CONFIG_JSON = 'load_balancer.config_json';

export interface LoadBalancerSettings {
  readonly enabled: boolean;
  readonly provider: LoadBalancerProviderName;
  readonly config: Record<string, unknown>;
}

export async function getLoadBalancerSettings(db: Database): Promise<LoadBalancerSettings> {
  const rows = await db.select().from(platformSettings);
  const get = (key: string): string | undefined => rows.find((r) => r.key === key)?.value ?? undefined;

  const enabled = get(SETTINGS_KEY_ENABLED) === 'true';
  const provider = (get(SETTINGS_KEY_PROVIDER) ?? 'null') as LoadBalancerProviderName;
  const configJson = get(SETTINGS_KEY_CONFIG_JSON);

  let config: Record<string, unknown> = {};
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Bad JSON in settings — fall back to empty config. Admin UI
      // should validate before save; this path is defensive.
    }
  }

  return { enabled, provider, config };
}

/**
 * Count of `cluster_nodes.role='server'` rows that were seen recently
 * (last_seen_at within 5 min). Stale server rows don't count toward
 * the HA gate — a dead server shouldn't unlock the LB toggle.
 */
async function freshServerCount(db: Database): Promise<number> {
  const result = await db.select({ n: sql<number>`count(*)::int` })
    .from(clusterNodes)
    .where(sql`${clusterNodes.role} = 'server' AND ${clusterNodes.lastSeenAt} > NOW() - INTERVAL '5 minutes'`);
  return result[0]?.n ?? 0;
}

/**
 * Gate for enabling the LB. Refuses when the cluster hasn't grown to
 * HA_GATE_MIN_SERVERS live server nodes yet — ADR-031 §8. The admin
 * UI calls this before showing the "Enable Load Balancer" toggle;
 * the backend re-checks on the actual save so a stale UI state
 * can't sneak an invalid activation through.
 */
export async function enforceHaGate(db: Database): Promise<void> {
  const n = await freshServerCount(db);
  if (n < HA_GATE_MIN_SERVERS) {
    throw new ApiError(
      'LB_HA_GATE_NOT_MET',
      `Load Balancer requires at least ${HA_GATE_MIN_SERVERS} live server nodes (currently ${n}).`,
      409,
      { required_servers: HA_GATE_MIN_SERVERS, current_servers: n },
    );
  }
}

/**
 * Update the LB settings. Validates the HA gate on enable, validates
 * provider name, leaves config JSON opaque (provider-specific).
 * Writes are individual upserts per key for audit-log granularity.
 */
export async function updateLoadBalancerSettings(
  db: Database,
  patch: Partial<LoadBalancerSettings>,
): Promise<LoadBalancerSettings> {
  if (patch.enabled === true) {
    await enforceHaGate(db);
  }
  if (patch.provider !== undefined && !['null', 'hetzner', 'aws', 'metallb'].includes(patch.provider)) {
    throw new ApiError('INVALID_FIELD_VALUE', `Unknown provider '${patch.provider}'`, 400, { field: 'provider' });
  }

  const entries: Array<{ key: string; value: string }> = [];
  if (patch.enabled !== undefined)  entries.push({ key: SETTINGS_KEY_ENABLED,  value: String(patch.enabled) });
  if (patch.provider !== undefined) entries.push({ key: SETTINGS_KEY_PROVIDER, value: patch.provider });
  if (patch.config !== undefined)   entries.push({ key: SETTINGS_KEY_CONFIG_JSON, value: JSON.stringify(patch.config) });

  for (const { key, value } of entries) {
    await db.insert(platformSettings).values({ key, value })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: sql`NOW()` } });
  }

  return getLoadBalancerSettings(db);
}

/**
 * Return a live provider instance ready to act. Callers typically
 * wrap this in a try/catch because stub providers throw "not
 * implemented" until someone wires them.
 */
export async function getActiveProvider(db: Database) {
  const settings = await getLoadBalancerSettings(db);
  if (!settings.enabled) return pickProvider('null');
  return pickProvider(settings.provider);
}

/**
 * Admin API endpoint surface — returns the public shape, not
 * internal implementation details. Excludes raw config when the
 * provider is stubbed (since config would be unused).
 */
export interface LoadBalancerStatus {
  readonly enabled: boolean;
  readonly provider: LoadBalancerProviderName;
  readonly haGate: {
    readonly met: boolean;
    readonly required: number;
    readonly current: number;
  };
  readonly providerImplemented: boolean;
  readonly message: string;
}

export async function getLoadBalancerStatus(db: Database): Promise<LoadBalancerStatus> {
  const settings = await getLoadBalancerSettings(db);
  const current = await freshServerCount(db);
  const met = current >= HA_GATE_MIN_SERVERS;
  const providerImplemented = settings.provider === 'null';

  let message: string;
  if (!settings.enabled) {
    message = 'Load Balancer is disabled — traffic uses direct DNS to server nodes.';
  } else if (!met) {
    message = `Enabled but HA gate not met (${current}/${HA_GATE_MIN_SERVERS} servers live). Provider calls will be skipped.`;
  } else if (!providerImplemented) {
    message = `Enabled with provider '${settings.provider}' which is not yet implemented. Switch to 'null' or wait for the M11+ follow-up.`;
  } else {
    message = 'Load Balancer enabled and active.';
  }

  return {
    enabled: settings.enabled,
    provider: settings.provider,
    haGate: { met, required: HA_GATE_MIN_SERVERS, current },
    providerImplemented,
    message,
  };
}
