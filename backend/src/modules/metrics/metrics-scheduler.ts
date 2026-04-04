import { hostingPlans, clients } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectClientMetrics } from './resource-metrics.js';
import type { Database } from '../../db/index.js';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour total cycle
const STAGGER_DELAY_MS = 2000; // 2 seconds between each client
const INITIAL_DELAY_MS = 30_000; // 30 seconds after startup

export function startMetricsScheduler(db: Database): NodeJS.Timeout {
  console.log('[metrics-scheduler] Starting hourly staggered refresh');

  const runCycle = async () => {
    try {
      const kubeconfigPath = process.env.KUBECONFIG_PATH;
      let k8s: ReturnType<typeof createK8sClients>;
      try {
        k8s = createK8sClients(kubeconfigPath);
      } catch {
        console.warn('[metrics-scheduler] K8s not available, skipping cycle');
        return;
      }

      // Get all provisioned clients
      const allClients = await db.select({
        id: clients.id,
        namespace: clients.kubernetesNamespace,
        planId: clients.planId,
        cpuLimitOverride: clients.cpuLimitOverride,
        memoryLimitOverride: clients.memoryLimitOverride,
        storageLimitOverride: clients.storageLimitOverride,
        provisioningStatus: clients.provisioningStatus,
      }).from(clients);

      const provisioned = allClients.filter(c => c.provisioningStatus === 'provisioned');

      // Get all plans for limit resolution
      const allPlans = await db.select().from(hostingPlans);
      const planMap = new Map(allPlans.map(p => [p.id, p]));

      for (let i = 0; i < provisioned.length; i++) {
        const client = provisioned[i];
        const plan = planMap.get(client.planId);

        const planLimits = {
          cpuLimit: Number(client.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
          memoryLimitGi: Number(client.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
          storageLimitGi: Number(client.storageLimitOverride ?? plan?.storageLimit ?? 50),
        };

        try {
          await collectClientMetrics(db, k8s, client.id, client.namespace, planLimits);
        } catch (err) {
          console.warn(`[metrics-scheduler] Failed for ${client.id}:`, err instanceof Error ? err.message : String(err));
        }

        // Stagger to avoid overwhelming K8s API
        if (i < provisioned.length - 1) {
          await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
        }
      }

      console.log(`[metrics-scheduler] Refreshed ${provisioned.length} clients`);
    } catch (err) {
      console.error('[metrics-scheduler] Cycle error:', err);
    }
  };

  // Run first cycle after 30 seconds (let app fully start)
  setTimeout(runCycle, INITIAL_DELAY_MS);

  return setInterval(runCycle, REFRESH_INTERVAL_MS);
}
