/**
 * Platform system settings — single-row configuration.
 *
 * Provides a cached getSettings() function that other modules call to read
 * settings without hitting the DB on every request. The cache is per-pod;
 * `updateSettings()` only invalidates the pod that handled the PATCH, so
 * with N replicas the other N-1 pods can still see stale values for up
 * to CACHE_TTL_MS. Keep the TTL short — a single-row read is cheap, and
 * a long TTL turns "operator flips a toggle" into a flaky behaviour
 * because subsequent requests round-robin across replicas. 5s is a
 * pragmatic upper bound for "felt like an instant" while still cutting
 * the per-request DB read by ~95% under normal load.
 */

import { eq, inArray } from 'drizzle-orm';
import { systemSettings, platformSettings, users, notifications } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { SystemSettings } from '../../db/schema.js';

const SETTINGS_ID = 'system';
const CACHE_TTL_MS = 5_000;

let cachedSettings: SystemSettings | null = null;
let cacheTimestamp = 0;

/**
 * Get system settings with in-memory caching.
 * Falls back to env vars for settings not yet stored in DB.
 */
export async function getSettings(db: Database): Promise<SystemSettings> {
  const now = Date.now();
  if (cachedSettings && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedSettings;
  }

  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));

  if (row) {
    cachedSettings = row;
    cacheTimestamp = now;
    return row;
  }

  // No row exists yet — insert defaults
  const defaults = {
    id: SETTINGS_ID,
    platformName: 'Hosting Platform',
    apiRateLimit: 100,
  };
  await db.insert(systemSettings).values(defaults).onConflictDoNothing();
  const [created] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  cachedSettings = created;
  cacheTimestamp = now;
  return created;
}

/**
 * Update system settings. Invalidates cache.
 */
export async function updateSettings(
  db: Database,
  input: Partial<Omit<SystemSettings, 'id' | 'updatedAt'>>,
): Promise<SystemSettings> {
  // Read the BEFORE values DIRECTLY from the DB (bypassing the in-pod
  // cache) so we can detect host-ports toggle transitions and reconcile
  // tenant-namespace PSA labels exactly once per change. Without this,
  // the toggle flips on but every existing tenant namespace stays at
  // enforce=baseline until its next routine provisioning touch —
  // which may never happen, leaving the firewall integration test
  // (and any real operator deploying a hostPort app) stuck on a
  // namespace that doesn't admit hostPort pods.
  //
  // Cache bypass: getSettings() serves from cachedSettings for up to
  // CACHE_TTL_MS. In a multi-replica deployment a sibling pod's PATCH
  // could update the DB while this pod still holds a stale value;
  // computing the transition off a stale value would either miss the
  // change (no reconcile) or fire a no-op (reconcile against
  // unchanged settings). Both are silent correctness failures. The
  // explicit query below is the source of truth.
  const [beforeRow] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  const beforeAllowHostPorts = !!(
    beforeRow?.allowHostPortsServer || beforeRow?.allowHostPortsWorker
  );

  await db.update(systemSettings)
    .set(input)
    .where(eq(systemSettings.id, SETTINGS_ID));

  // Propagate to the key-value platformSettings table (used by ingress-routes/service.ts)
  if (input.ingressBaseDomain !== undefined) {
    await db.insert(platformSettings).values({ key: 'ingress_base_domain', value: input.ingressBaseDomain ?? '' })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: input.ingressBaseDomain ?? '' } });
  }

  // Invalidate cache
  cachedSettings = null;
  cacheTimestamp = 0;

  const after = await getSettings(db);
  const afterAllowHostPorts = !!(after.allowHostPortsServer || after.allowHostPortsWorker);

  if (beforeAllowHostPorts !== afterAllowHostPorts) {
    // Fire-and-forget — reconcile runs against every tenant namespace
    // and can take a few seconds on a large cluster. The toggle write
    // already succeeded; the reconcile is eventual-consistency catchup.
    //
    // KNOWN admission race window: between the DB write completing and
    // the last namespace being patched, there is a brief gap during
    // which:
    //   - ON  direction: a new hostPort deployment is accepted by
    //     platform-api (cached settings now true) but admission still
    //     rejects the Pod because the namespace label hasn't been
    //     patched yet. The deployment retries; once the reconciler
    //     reaches that namespace the Pod admits. Operationally
    //     equivalent to a 1-2s delay on the first hostPort deploy
    //     after the toggle flip.
    //   - OFF direction: a tenant in a not-yet-patched namespace can
    //     still admit a hostPort Pod that they SHOULDN'T be able to.
    //     The Pod continues running after the patch lands (PSA only
    //     checks at admission). The operational signal "turning the
    //     toggle off only blocks new deploys; running workloads keep
    //     their open ports until deleted" already covers this — the
    //     additional 1-2s catch-up is a narrow widening of that window.
    //
    // Failure handling: partial per-namespace failures are surfaced
    // as admin notifications so an operator who flipped the toggle
    // can see if any tenant namespace was left at the wrong PSA
    // level (RBAC, transient API errors, etc.). The toggle write
    // itself never fails on reconcile errors — the operator's
    // setting persists regardless.
    void (async () => {
      try {
        const { reconcileTenantNamespacePsa } = await import('../k8s-provisioner/tenant-psa-reconciler.js');
        const result = await reconcileTenantNamespacePsa(db, afterAllowHostPorts);
        if (result.failed.length > 0) {
          // Best-effort notification — never let logging failures
          // escape into the toggle-write flow.
          await emitPsaReconcileNotification(db, afterAllowHostPorts, result).catch((err) => {
            console.warn(`[system-settings] failed to write PSA reconcile notification: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        console.warn(`[system-settings] tenant-namespace PSA reconcile after toggle change failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  return after;
}

/**
 * Get a single setting value with env var fallback.
 * Use this in other modules for settings that were previously env vars.
 */
export async function getSetting<K extends keyof SystemSettings>(
  db: Database,
  key: K,
  envFallback?: string,
): Promise<SystemSettings[K] | string> {
  const settings = await getSettings(db);
  const value = settings[key];
  if (value !== null && value !== undefined && value !== '') return value;
  return envFallback ?? process.env[key.toUpperCase()] ?? '';
}

/**
 * Write an admin-bell notification when the host-ports toggle's
 * post-write tenant-namespace PSA reconciler has partial failures.
 * Fans out one row per super_admin / admin user (notifications.user_id
 * is per-recipient). Mirrors the pattern used by namespace-integrity.
 *
 * Errors are surfaced via console.warn at the call site — this helper
 * does NOT swallow per-recipient write errors so the operator gets the
 * full picture in the logs.
 */
async function emitPsaReconcileNotification(
  db: Database,
  afterAllowHostPorts: boolean,
  result: { attempted: number; succeeded: number; failed: string[] },
): Promise<void> {
  const adminRows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.roleName, ['super_admin', 'admin']));
  const enforceLevel = afterAllowHostPorts ? 'privileged' : 'baseline';
  const title = `Host-ports toggle flip: ${result.failed.length} of ${result.attempted} tenant namespace(s) NOT updated`;
  const message =
    `Tenant-namespace PodSecurity enforce label was updated to '${enforceLevel}' on ` +
    `${result.succeeded}/${result.attempted} namespaces. ` +
    `Failed: ${result.failed.slice(0, 5).join('; ')}` +
    (result.failed.length > 5 ? ` (+${result.failed.length - 5} more — see platform-api logs)` : '') +
    `. Affected tenants stay at the OLD enforce level until the next provisioning ` +
    `touch (e.g. namespace-integrity repair or an explicit re-provision). On a host-ports ` +
    `ON cluster this means hostPort deploys to those tenants will be rejected by k8s ` +
    `admission. On an OFF cluster this means tenants in failed namespaces can still admit ` +
    `hostPort pods until catch-up converges.`;
  for (const a of adminRows) {
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: a.id,
      type: 'error',
      title,
      message,
      resourceType: null,
      resourceId: null,
    }).catch((err) => {
      console.warn(`[system-settings] PSA reconcile notification insert failed for user ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
