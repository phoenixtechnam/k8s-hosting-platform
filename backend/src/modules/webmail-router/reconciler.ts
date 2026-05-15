/**
 * Webmail router — flips the platform-wide `webmail.<apex>`
 * IngressRoute's backend Service to match the active webmail engine.
 *
 * The `platform-webmail-ingress` IngressRoute in the `mail` namespace
 * is created statically by `k8s/overlays/<env>/webmail-ingress.yaml`
 * with `services[0].name = roundcube`. When the operator flips
 * `platform_settings.default_webmail_engine` to `bulwark`, this
 * reconciler patches the IngressRoute to target
 * `bulwark-impersonator` instead — the Bulwark sidecar that handles
 * /_impersonate JWT handoffs and proxies regular traffic to the
 * Bulwark SPA.
 *
 * Only one engine is active on `webmail.<apex>` at any time. Per-tenant
 * Roundcube subdomains (`webmail.<clientdomain>`) are unaffected — they
 * always point at the Roundcube Service regardless of this setting.
 *
 * Idempotent: if the IngressRoute already targets the expected
 * Service, the reconciler is a no-op (no patch, no API call beyond
 * the read).
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { getDefaultWebmailEngine, type WebmailEngine } from '../webmail-settings/service.js';

export const WEBMAIL_IR_NAME = 'platform-webmail-ingress';
export const WEBMAIL_IR_NAMESPACE = 'mail';
const TRAEFIK_GROUP = 'traefik.io';
const TRAEFIK_VERSION = 'v1alpha1';
const TRAEFIK_PLURAL = 'ingressroutes';

/**
 * Maps an engine key to the Service name the IngressRoute should
 * target. Both Services live in `mail/`. `bulwark-impersonator` is a
 * sidecar Service that selects the same Pod as the bulwark Deployment;
 * it owns port 80 → impersonator:8081.
 */
export function serviceNameForEngine(engine: WebmailEngine): string {
  return engine === 'bulwark' ? 'bulwark-impersonator' : 'roundcube';
}

interface IngressRoute {
  readonly spec?: {
    readonly routes?: ReadonlyArray<{
      readonly services?: ReadonlyArray<{ readonly name: string; readonly port?: number | string }>;
    }>;
  };
}

export interface ReconcileResult {
  readonly engine: WebmailEngine;
  readonly expectedService: string;
  readonly previousService: string | null;
  readonly patched: boolean;
}

/**
 * Inspect the IngressRoute and patch services[0].name when it doesn't
 * already match the active engine. Failure to find the IR (e.g. fresh
 * cluster before the static YAML applies, or running in CI without
 * Traefik installed) is non-fatal — the reconciler logs and returns
 * an unpatched result.
 */
export async function reconcileWebmailIngress(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<ReconcileResult | null> {
  const engine = await getDefaultWebmailEngine(db);
  const expectedService = serviceNameForEngine(engine);

  let current: IngressRoute;
  try {
    current = (await custom.getNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: WEBMAIL_IR_NAMESPACE,
      plural: TRAEFIK_PLURAL,
      name: WEBMAIL_IR_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as IngressRoute;
  } catch (err) {
    log.warn(
      { err, name: WEBMAIL_IR_NAME, namespace: WEBMAIL_IR_NAMESPACE },
      'webmail-router: IngressRoute not found — skipping reconcile',
    );
    return null;
  }

  const firstRoute = current.spec?.routes?.[0];
  const previousService = firstRoute?.services?.[0]?.name ?? null;

  if (previousService === expectedService) {
    return { engine, expectedService, previousService, patched: false };
  }

  // Patch the first route's services array. We replace the entire
  // services list to clear any stale entries; the IR only has a single
  // route (Host=`webmail.<apex>`) and a single backend Service.
  const port = firstRoute?.services?.[0]?.port ?? 80;
  const body = {
    spec: {
      routes: [
        {
          ...firstRoute,
          services: [{ name: expectedService, port }],
        },
      ],
    },
  };

  await custom.patchNamespacedCustomObject(
    {
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: WEBMAIL_IR_NAMESPACE,
      plural: TRAEFIK_PLURAL,
      name: WEBMAIL_IR_NAME,
      body,
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );

  log.info(
    { engine, previousService, newService: expectedService },
    'webmail-router: IngressRoute flipped to match active engine',
  );

  return { engine, expectedService, previousService, patched: true };
}
