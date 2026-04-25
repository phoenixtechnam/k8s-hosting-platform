import { inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { notifications, users } from '../../db/schema.js';
import { collectNodeSubsystemHealth } from './service.js';

// Issue 3 fix: detect worker nodes whose Calico or Longhorn CSI is
// degraded and surface the regression via the notifications table.
// In-memory state tracks the previous tick so we only fire once per
// state change instead of every minute.

interface PrevState {
  calicoHealthy: boolean;
  longhornCsiHealthy: boolean;
}

const SUBSYSTEM_INTERVAL_MS = 5 * 60 * 1000; // 5 min — fast enough to catch a join failure
const INITIAL_DELAY_MS = 60_000;

export function startNodeHealthReconciler(db: Database, k8s: K8sClients): { stop: () => void } {
  console.log('[node-health] starting reconciler (5min cadence)');
  const lastState = new Map<string, PrevState>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const reports = await collectNodeSubsystemHealth(k8s);
      const transitions: Array<{ node: string; reason: string; severity: 'error' | 'warning' | 'success' }> = [];

      for (const r of reports) {
        const calicoHealthy = r.calico === 'healthy';
        const longhornCsiHealthy = r.longhornCsi === 'healthy' && r.csiDriverRegistered;
        const prev = lastState.get(r.nodeName);
        if (!prev) {
          // first observation — record state, only fire if degraded
          lastState.set(r.nodeName, { calicoHealthy, longhornCsiHealthy });
          if (!calicoHealthy) {
            transitions.push({ node: r.nodeName, reason: `Calico is ${r.calico} on '${r.nodeName}'${r.calicoMessage ? ` — ${r.calicoMessage}` : ''}`, severity: 'error' });
          }
          if (!longhornCsiHealthy) {
            transitions.push({ node: r.nodeName, reason: `Longhorn CSI is ${r.longhornCsi} on '${r.nodeName}'${r.longhornCsiMessage ? ` — ${r.longhornCsiMessage}` : ''}`, severity: 'error' });
          }
          continue;
        }
        if (prev.calicoHealthy !== calicoHealthy) {
          transitions.push({
            node: r.nodeName,
            reason: calicoHealthy
              ? `Calico recovered on '${r.nodeName}'`
              : `Calico regressed on '${r.nodeName}' — ${r.calicoMessage ?? r.calico}`,
            severity: calicoHealthy ? 'success' : 'error',
          });
        }
        if (prev.longhornCsiHealthy !== longhornCsiHealthy) {
          transitions.push({
            node: r.nodeName,
            reason: longhornCsiHealthy
              ? `Longhorn CSI recovered on '${r.nodeName}'`
              : `Longhorn CSI regressed on '${r.nodeName}' — ${r.longhornCsiMessage ?? r.longhornCsi}`,
            severity: longhornCsiHealthy ? 'success' : 'error',
          });
        }
        lastState.set(r.nodeName, { calicoHealthy, longhornCsiHealthy });
      }

      if (transitions.length > 0) {
        const adminRows = await db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
        for (const t of transitions) {
          for (const a of adminRows) {
            await db.insert(notifications).values({
              id: crypto.randomUUID(),
              userId: a.id,
              type: t.severity === 'success' ? 'success' : t.severity === 'error' ? 'error' : 'warning',
              title: `Node subsystem health: ${t.node}`,
              message: t.reason,
              resourceType: 'cluster_node',
              resourceId: t.node,
            }).catch((err) => {
              console.error('[node-health] notification write failed:', (err as Error).message);
            });
          }
        }
      }
    } catch (err) {
      console.error('[node-health] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, SUBSYSTEM_INTERVAL_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
