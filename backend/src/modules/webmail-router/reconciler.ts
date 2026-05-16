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
import { MERGE_PATCH, applyRaw } from '../../shared/k8s-patch.js';
import {
  getDefaultWebmailEngine,
  getDefaultWebmailUrl,
  type WebmailEngine,
} from '../webmail-settings/service.js';

export const WEBMAIL_IR_NAME = 'platform-webmail-ingress';
export const WEBMAIL_IR_NAMESPACE = 'mail';
export const BULWARK_DEPLOY_NAME = 'bulwark';
export const BULWARK_DEPLOY_NAMESPACE = 'mail';
export const WEBMAIL_ROUTER_FIELD_MANAGER = 'platform-api-webmail-router';
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
  readonly metadata?: {
    readonly annotations?: Record<string, string>;
  };
  readonly spec?: {
    readonly routes?: ReadonlyArray<{
      readonly services?: ReadonlyArray<{ readonly name: string; readonly port?: number | string }>;
    }>;
  };
}

// Flux annotation that tells the kustomize-controller to skip this
// resource. Without it, every patch we apply gets reverted ~60s later
// when Flux reconciles the static YAML's services[0].name back to
// `roundcube`. The static webmail-ingress.yaml carries this annotation,
// but the reconciler re-stamps it defensively in case the IR was
// created manually or the annotation was edited away.
const FLUX_RECONCILE_DISABLED = { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' };

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
  const currentAnnotations = current.metadata?.annotations ?? {};
  const annotationMissing =
    currentAnnotations['kustomize.toolkit.fluxcd.io/reconcile'] !== 'disabled';

  if (previousService === expectedService && !annotationMissing) {
    return { engine, expectedService, previousService, patched: false };
  }

  // Patch the first route's services array. We replace the entire
  // services list to clear any stale entries; the IR only has a single
  // route (Host=`webmail.<apex>`) and a single backend Service. Also
  // re-stamp the Flux `reconcile: disabled` annotation so a future
  // YAML change can't accidentally hand ownership back to Flux.
  const port = firstRoute?.services?.[0]?.port ?? 80;
  const body = {
    metadata: { annotations: FLUX_RECONCILE_DISABLED },
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

/**
 * Normalise an arbitrary URL the operator typed into the admin panel
 * to an origin (scheme + host + optional port, no path). Bulwark's
 * /api/auth/stalwart-context expects the Origin header to be an exact
 * origin string — trailing slashes and paths break the same-origin
 * check on the SPA's subsequent /api/account/stalwart/jmap call.
 *
 * Returns `null` if the URL is not parseable so the caller can skip
 * the env sync rather than push an invalid value into the Pod.
 */
export function originFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export interface OriginReconcileResult {
  readonly expectedOrigin: string;
  readonly previousOrigin: string | null;
  readonly patched: boolean;
}

/**
 * Sync the Bulwark Deployment's impersonator container env
 * `PUBLIC_ORIGIN` to match the platform's Default Webmail URL setting.
 *
 * Why this matters: Bulwark's Next.js backend treats `PUBLIC_ORIGIN`
 * as the authoritative same-origin pin. Its `/api/auth/stalwart-context`
 * endpoint binds the session cookie to that origin; any subsequent
 * `/api/account/stalwart/jmap` call from a DIFFERENT origin gets 401
 * "Not authenticated" even when the cookie is presented. Before this
 * reconciler, PUBLIC_ORIGIN was a static `https://bulwark.<apex>` baked
 * into the Deployment YAML; flipping the webmail URL via the admin
 * panel to anything else (e.g. `https://webmail.<apex>` per the
 * Phase 10 mutex model) left the impersonator's Origin header out of
 * sync with the SPA's actual request origin, breaking webmail entirely.
 *
 * Uses Server-Side Apply with a dedicated field-manager so Flux's
 * subsequent reconcile (with `kustomize.toolkit.fluxcd.io/ssa: Merge`
 * on the Deployment) respects platform-api's ownership of just this
 * env value.
 *
 * Failure to read the Deployment (e.g. fresh cluster, no mail stack)
 * is non-fatal — the reconciler logs and returns null.
 */
export async function reconcileBulwarkOrigin(
  db: Database,
  kc: k8s.KubeConfig,
  apps: k8s.AppsV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<OriginReconcileResult | null> {
  const webmailUrl = await getDefaultWebmailUrl(db);
  const expectedOrigin = originFromUrl(webmailUrl);
  if (!expectedOrigin) {
    log.warn(
      { webmailUrl },
      'webmail-router: default_webmail_url is not a parseable URL — skipping origin sync',
    );
    return null;
  }

  let deploy: { spec?: { template?: { spec?: { containers?: ReadonlyArray<{
    name?: string;
    env?: ReadonlyArray<{ name?: string; value?: string }>;
  }> } } } };
  try {
    deploy = (await apps.readNamespacedDeployment({
      namespace: BULWARK_DEPLOY_NAMESPACE,
      name: BULWARK_DEPLOY_NAME,
    } as unknown as Parameters<typeof apps.readNamespacedDeployment>[0])) as never;
  } catch (err) {
    log.warn(
      { err, name: BULWARK_DEPLOY_NAME, namespace: BULWARK_DEPLOY_NAMESPACE },
      'webmail-router: Bulwark Deployment not found — skipping origin sync',
    );
    return null;
  }

  const impersonator = deploy.spec?.template?.spec?.containers?.find(
    (c) => c.name === 'impersonator',
  );
  const previousOrigin =
    impersonator?.env?.find((e) => e.name === 'PUBLIC_ORIGIN')?.value ?? null;

  if (previousOrigin === expectedOrigin) {
    return { expectedOrigin, previousOrigin, patched: false };
  }

  // SSA-apply just the impersonator container's env array. We list every
  // PUBLIC_ORIGIN value we want to claim ownership of; everything else
  // (BULWARK_HOST, JWT_SECRET, master-user secrets, ...) stays under
  // Flux ownership.
  const body = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: BULWARK_DEPLOY_NAME, namespace: BULWARK_DEPLOY_NAMESPACE },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'impersonator',
              env: [{ name: 'PUBLIC_ORIGIN', value: expectedOrigin }],
            },
          ],
        },
      },
    },
  };

  await applyRaw(
    kc,
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      namespace: BULWARK_DEPLOY_NAMESPACE,
      name: BULWARK_DEPLOY_NAME,
      resource: 'deployments',
      apiPath: 'apis/apps/v1',
    },
    body,
    { fieldManager: WEBMAIL_ROUTER_FIELD_MANAGER, force: true },
  );

  log.info(
    { previousOrigin, newOrigin: expectedOrigin, webmailUrl },
    'webmail-router: Bulwark PUBLIC_ORIGIN synced to platform default webmail URL',
  );

  return { expectedOrigin, previousOrigin, patched: true };
}
