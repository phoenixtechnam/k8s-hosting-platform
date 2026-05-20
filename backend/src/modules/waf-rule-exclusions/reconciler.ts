/**
 * F4 — WAF rule exclusion reconciler.
 *
 * Reads enabled rows from `waf_rule_exclusions`, renders the
 * SecRule snippet, applies the `modsec-crs-exclusions-dynamic`
 * ConfigMap in the `traefik` namespace, and stamps a hash annotation
 * on the modsec-crs Deployment so a content change triggers a rolling
 * restart (pods pick up the new .conf at startup via the volume mount).
 *
 * Idempotent — when ConfigMap + annotation already match the rendered
 * hash, the reconciler is a no-op. Called inline after every
 * create/update/delete from routes.ts AND on a 5-min scheduler tick
 * for drift recovery (same pattern as webmail-feature-css).
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { listExclusionsForReconciler } from './service.js';
import { renderExclusions, type RenderResult } from './renderer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export const WAF_EXCLUSION_CM_NAME = 'modsec-crs-exclusions-dynamic';
export const WAF_EXCLUSION_CM_NAMESPACE = 'traefik';
export const WAF_EXCLUSION_CM_KEY = 'REQUEST-901-EXCLUSION-RULES-BEFORE-CRS-DYNAMIC.conf';
export const WAF_EXCLUSION_HASH_ANNOTATION =
  'platform.phoenix-host.net/waf-exclusion-hash';
export const WAF_EXCLUSION_FIELD_MANAGER = 'platform-api-waf-rule-exclusions';
export const MODSEC_DEPLOY_NAME = 'modsec-crs';

export interface WafExclusionClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

export interface ReconcileResult {
  readonly hash: string;
  readonly count: number;
  readonly cmCreated: boolean;
  readonly cmUpdated: boolean;
  readonly deployStamped: boolean;
}

interface ConfigMapShape {
  readonly data?: Record<string, string>;
  readonly metadata?: { readonly annotations?: Record<string, string> };
}

interface DeploymentShape {
  readonly spec?: {
    readonly template?: {
      readonly metadata?: { readonly annotations?: Record<string, string> };
    };
  };
}

export async function reconcileWafExclusions(
  db: Db,
  clients: WafExclusionClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<ReconcileResult> {
  const exclusions = await listExclusionsForReconciler(db);
  const rendered: RenderResult = renderExclusions(exclusions);

  const desiredData: Record<string, string> = {
    [WAF_EXCLUSION_CM_KEY]: rendered.body,
  };

  let cmCreated = false;
  let cmUpdated = false;
  let live: ConfigMapShape | null = null;

  try {
    live = (await clients.core.readNamespacedConfigMap({
      name: WAF_EXCLUSION_CM_NAME,
      namespace: WAF_EXCLUSION_CM_NAMESPACE,
    } as unknown as Parameters<typeof clients.core.readNamespacedConfigMap>[0])) as ConfigMapShape;
  } catch (err) {
    const statusCode = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (statusCode !== 404) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'waf-rule-exclusions: ConfigMap read failed (non-404) — bailing this pass',
      );
      throw err;
    }
    live = null;
  }

  if (!live) {
    await clients.core.createNamespacedConfigMap({
      namespace: WAF_EXCLUSION_CM_NAMESPACE,
      body: {
        metadata: {
          name: WAF_EXCLUSION_CM_NAME,
          namespace: WAF_EXCLUSION_CM_NAMESPACE,
          labels: {
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'waf',
            'app.kubernetes.io/managed-by': WAF_EXCLUSION_FIELD_MANAGER,
          },
          annotations: {
            [WAF_EXCLUSION_HASH_ANNOTATION]: rendered.hash,
          },
        },
        data: desiredData,
      },
    } as unknown as Parameters<typeof clients.core.createNamespacedConfigMap>[0]);
    cmCreated = true;
    log.info(
      { hash: rendered.hash, count: rendered.count },
      'waf-rule-exclusions: ConfigMap created',
    );
  } else {
    const drift = live.data?.[WAF_EXCLUSION_CM_KEY] !== rendered.body;
    if (drift) {
      await clients.core.patchNamespacedConfigMap(
        {
          name: WAF_EXCLUSION_CM_NAME,
          namespace: WAF_EXCLUSION_CM_NAMESPACE,
          body: {
            metadata: {
              annotations: { [WAF_EXCLUSION_HASH_ANNOTATION]: rendered.hash },
            },
            data: desiredData,
          },
        } as unknown as Parameters<typeof clients.core.patchNamespacedConfigMap>[0],
        MERGE_PATCH,
      );
      cmUpdated = true;
      log.info(
        { hash: rendered.hash, count: rendered.count },
        'waf-rule-exclusions: ConfigMap updated (drift detected)',
      );
    }
  }

  // ─── Stamp hash on modsec-crs Deployment pod-template annotations ──
  // Triggers a rolling restart so pods pick up the new .conf via the
  // volume mount. We skip the patch when the live annotation already
  // matches to avoid log noise on unchanged ticks.
  let deployStamped = false;
  try {
    const dep = (await clients.apps.readNamespacedDeployment({
      name: MODSEC_DEPLOY_NAME,
      namespace: WAF_EXCLUSION_CM_NAMESPACE,
    } as unknown as Parameters<typeof clients.apps.readNamespacedDeployment>[0])) as DeploymentShape;
    const current = dep.spec?.template?.metadata?.annotations?.[
      WAF_EXCLUSION_HASH_ANNOTATION
    ];
    if (current !== rendered.hash) {
      await clients.apps.patchNamespacedDeployment(
        {
          name: MODSEC_DEPLOY_NAME,
          namespace: WAF_EXCLUSION_CM_NAMESPACE,
          body: {
            spec: {
              template: {
                metadata: {
                  annotations: { [WAF_EXCLUSION_HASH_ANNOTATION]: rendered.hash },
                },
              },
            },
          },
        } as unknown as Parameters<typeof clients.apps.patchNamespacedDeployment>[0],
        MERGE_PATCH,
      );
      deployStamped = true;
      log.info(
        { hash: rendered.hash },
        'waf-rule-exclusions: modsec-crs Deployment annotated → rolling restart',
      );
    }
  } catch (err) {
    const statusCode = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    // 404 = modsec-crs not deployed (single-cluster overlays may omit it).
    // Soft-fail so the rest of the platform keeps converging.
    if (statusCode !== 404) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'waf-rule-exclusions: modsec-crs Deployment patch failed (non-blocking)',
      );
    }
  }

  return {
    hash: rendered.hash,
    count: rendered.count,
    cmCreated,
    cmUpdated,
    deployStamped,
  };
}
