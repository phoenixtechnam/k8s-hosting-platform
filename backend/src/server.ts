import { loadConfig } from './config/index.js';
import { getDb, closeDb } from './db/index.js';
import { buildApp } from './app.js';
import { suspendExpiredTenants } from './modules/subscriptions/expiry-checker.js';
import { runAutoUpgradePass } from './modules/deployments/auto-upgrade-cron.js';
import { createK8sClients } from './modules/k8s-provisioner/k8s-client.js';
import { bootstrapSystemTenant } from './modules/system-tenant/bootstrap.js';

const config = loadConfig();
const db = getDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

// Declare the timer holder up front so the shutdown handler can
// reference it safely. SIGTERM that arrives before app.listen()
// completes (e.g. readiness probe failure during onReady) used to
// hit a TDZ on `expiryCheckTimer` and exit the container with
// ReferenceError, masking the real Fastify boot timeout in the logs.
let expiryCheckTimer: NodeJS.Timeout | null = null;
let autoUpgradeTimer: NodeJS.Timeout | null = null;

const shutdown = async () => {
  if (expiryCheckTimer) clearInterval(expiryCheckTimer);
  if (autoUpgradeTimer) clearInterval(autoUpgradeTimer);
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Server listening on port ${config.PORT}`);

// SYSTEM tenant self-healing pass (ADR-040). Runs on every startup
// (~10 ms when the row already exists) so a Postgres restore from a
// pre-SYSTEM backup, or accidental direct-SQL deletion, gets caught
// before any operator action. seed.ts must have created hosting_plans
// + regions first; if missing, log and continue — the platform can
// still serve requests, just without an indelible SYSTEM row.
(async () => {
  try {
    const getStartupK8s = () => {
      try { return createK8sClients(config.KUBECONFIG_PATH); } catch { return null; }
    };
    const result = await bootstrapSystemTenant(db, {
      k8s: getStartupK8s(),
      log: {
        info: (msg) => app.log.info(msg),
        warn: (msg, err) => app.log.warn({ err }, msg),
      },
    });
    if (result.created) {
      app.log.info(`[system-tenant] bootstrap created SYSTEM tenant ${result.tenantId}`);
    }
  } catch (err) {
    app.log.warn({ err }, '[system-tenant] startup bootstrap failed (continuing)');
  }
})();

// Check for expired subscriptions every hour
const EXPIRY_CHECK_INTERVAL = 60 * 60 * 1000;
expiryCheckTimer = setInterval(async () => {
  try {
    const count = await suspendExpiredTenants(db);
    if (count > 0) {
      app.log.info(`Auto-suspended ${count} tenant(s) with expired subscriptions`);
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to check expired subscriptions');
  }
}, EXPIRY_CHECK_INTERVAL);

// Run immediately on startup
suspendExpiredTenants(db).catch((err) => {
  app.log.error({ err }, 'Failed initial expired subscription check');
});

// Auto-upgrade cron — runs every 24h. Opt-in per deployment via
// deployments.autoUpgrade=true. Strict apps are always skipped (handled
// inside runAutoUpgradePass + at the setAutoUpgrade API). The k8s tenant
// is lazily created; if no kubeconfig is available (e.g. unit-test boot),
// the cron is a no-op.
const AUTO_UPGRADE_INTERVAL = 24 * 60 * 60 * 1000;
const getAutoUpgradeK8s = () => {
  try {
    return createK8sClients(config.KUBECONFIG_PATH);
  } catch {
    return null;
  }
};
autoUpgradeTimer = setInterval(async () => {
  try {
    const result = await runAutoUpgradePass(db, getAutoUpgradeK8s());
    if (result.upgraded > 0 || result.failed > 0) {
      app.log.info(
        `[auto-upgrade] attempted=${result.attempted} upgraded=${result.upgraded} skipped=${result.skipped} failed=${result.failed}`,
      );
    }
    if (result.failures.length > 0) {
      for (const f of result.failures) {
        app.log.warn(`[auto-upgrade] deployment ${f.deploymentId}: ${f.error}`);
      }
    }
  } catch (err) {
    app.log.error({ err }, 'Auto-upgrade cron pass failed');
  }
}, AUTO_UPGRADE_INTERVAL);
