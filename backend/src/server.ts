import { loadConfig } from './config/index.js';
import { getDb, closeDb } from './db/index.js';
import { buildApp } from './app.js';
import { suspendExpiredClients } from './modules/subscriptions/expiry-checker.js';
import { reconcileDeploymentStatuses } from './modules/deployments/status-reconciler.js';
import { createK8sClients } from './modules/k8s-provisioner/k8s-client.js';

const config = loadConfig();
const db = getDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async () => {
  clearInterval(expiryCheckTimer);
  clearInterval(reconcileTimer);
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Server listening on port ${config.PORT}`);

// Check for expired subscriptions every hour
const EXPIRY_CHECK_INTERVAL = 60 * 60 * 1000;
const expiryCheckTimer = setInterval(async () => {
  try {
    const count = await suspendExpiredClients(db);
    if (count > 0) {
      app.log.info(`Auto-suspended ${count} client(s) with expired subscriptions`);
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to check expired subscriptions');
  }
}, EXPIRY_CHECK_INTERVAL);

// Run immediately on startup
suspendExpiredClients(db).catch((err) => {
  app.log.error({ err }, 'Failed initial expired subscription check');
});

// Reconcile deployment statuses every 60 seconds
const RECONCILE_INTERVAL = 60_000;
const reconcileTimer = setInterval(async () => {
  try {
    const k8s = createK8sClients(config.KUBECONFIG_PATH);
    if (!k8s) return;
    const result = await reconcileDeploymentStatuses(db, k8s);
    if (result.updated > 0) {
      app.log.info(`Reconciled ${result.updated} deployment status(es) (${result.checked} checked)`);
    }
    if (result.errors.length > 0) {
      app.log.warn({ errors: result.errors }, 'Deployment reconciliation had errors');
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to reconcile deployment statuses');
  }
}, RECONCILE_INTERVAL);
