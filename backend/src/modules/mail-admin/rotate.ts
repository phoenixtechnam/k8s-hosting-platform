import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import * as k8s from '@kubernetes/client-node';
import {
  rotateStalwartPasswordResponseSchema,
  type RotateStalwartPasswordResponse,
} from '@k8s-hosting/api-contracts';

// ─── Public API ───────────────────────────────────────────────────────────

export interface RotateOptions {
  readonly kubeconfigPath: string | undefined;
  readonly stalwartNamespace: string;
  readonly platformNamespace: string;
  readonly secretName: string;
  // Mirror secret in the platform namespace so platform-api can read the
  // cleartext via envFrom/secretKeyRef (k8s Secrets are namespace-scoped).
  readonly platformMirrorSecretName: string;
  readonly stalwartStatefulSetName: string;
  readonly platformDeploymentName: string;
  readonly stalwartMgmtHost: string;
  readonly stalwartMgmtPort: number;
  readonly username: string;
  readonly verifyTimeoutMs: number;
}

/**
 * Rotate Stalwart's fallback-admin password end-to-end.
 *
 * Steps (failure at any step aborts and leaves cluster in the "old creds"
 * state — the patch step is the first destructive action; Stalwart keeps
 * using the old hash until the pod restarts):
 *   1. generate random password + bcrypt hash
 *   2. PATCH stalwart-secrets (ADMIN_SECRET + ADMIN_SECRET_PLAIN)
 *   3. rollout restart stalwart-mail StatefulSet, wait Ready
 *   4. rollout restart platform-api Deployment, wait Ready
 *   5. poll Stalwart's /api/oauth with new creds until 200, or deadline.
 */
export async function rotateStalwartPassword(opts: RotateOptions): Promise<RotateStalwartPasswordResponse> {
  return rotateStalwartPasswordImpl(opts, defaultDeps(opts.kubeconfigPath));
}

// ─── Dependency injection seam for tests ──────────────────────────────────

export interface RotateDeps {
  generatePassword(): string;
  hashPassword(plain: string): Promise<string>;
  patchSecret(req: { namespace: string; name: string; stringData: Record<string, string> }): Promise<void>;
  restartStatefulSet(req: { namespace: string; name: string }): Promise<void>;
  waitForStatefulSetReady(req: { namespace: string; name: string; timeoutMs: number }): Promise<void>;
  restartDeployment(req: { namespace: string; name: string }): Promise<void>;
  waitForDeploymentReady(req: { namespace: string; name: string; timeoutMs: number }): Promise<void>;
  verifyCredentials(req: { host: string; port: number; username: string; password: string }): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export async function rotateStalwartPasswordImpl(
  opts: RotateOptions,
  deps: RotateDeps,
): Promise<RotateStalwartPasswordResponse> {
  const plain = deps.generatePassword();
  const hash = await deps.hashPassword(plain);

  await deps.patchSecret({
    namespace: opts.stalwartNamespace,
    name: opts.secretName,
    stringData: {
      ADMIN_SECRET: hash,
      ADMIN_SECRET_PLAIN: plain,
    },
  });

  // Mirror the cleartext into the platform namespace so platform-api's
  // env can pick up the new value on restart. This is only needed because
  // Kubernetes Secrets are namespace-scoped; in prod the same rotation
  // happens, on a same-shape mirror secret.
  await deps.patchSecret({
    namespace: opts.platformNamespace,
    name: opts.platformMirrorSecretName,
    stringData: {
      ADMIN_SECRET_PLAIN: plain,
    },
  });

  // Stalwart restart must complete BEFORE platform-api restarts — otherwise
  // platform-api picks up the new cleartext while Stalwart is still hashing
  // against the old one, and every admin call 401s until Stalwart catches up.
  await deps.restartStatefulSet({
    namespace: opts.stalwartNamespace,
    name: opts.stalwartStatefulSetName,
  });
  await deps.waitForStatefulSetReady({
    namespace: opts.stalwartNamespace,
    name: opts.stalwartStatefulSetName,
    timeoutMs: 120_000,
  });

  await deps.restartDeployment({
    namespace: opts.platformNamespace,
    name: opts.platformDeploymentName,
  });
  await deps.waitForDeploymentReady({
    namespace: opts.platformNamespace,
    name: opts.platformDeploymentName,
    timeoutMs: 120_000,
  });

  // Poll Stalwart auth until the new creds work or we give up.
  const deadline = deps.now().getTime() + opts.verifyTimeoutMs;
  let ok = false;
  while (deps.now().getTime() < deadline) {
    ok = await deps.verifyCredentials({
      host: opts.stalwartMgmtHost,
      port: opts.stalwartMgmtPort,
      username: opts.username,
      password: plain,
    });
    if (ok) break;
    await deps.sleep(2_000);
  }
  if (!ok) {
    throw new Error(
      'Rotation succeeded at the Secret + rollout layers but the new credentials could not be verified against Stalwart within the timeout. Check Stalwart logs.',
    );
  }

  return rotateStalwartPasswordResponseSchema.parse({
    username: opts.username,
    password: plain,
    rotatedAt: deps.now().toISOString(),
  });
}

// ─── Default helpers (used by the real rotate endpoint) ───────────────────

/**
 * 32-byte random password, base64url-encoded and stripped of padding.
 * Typical output is ~43 chars, URL/shell-safe alphabet.
 */
export function generateUrlSafePassword(bytes = 32): string {
  return randomBytes(bytes).toString('base64url').replace(/=+$/, '');
}

function defaultDeps(kubeconfigPath: string | undefined): RotateDeps {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  return {
    generatePassword: () => generateUrlSafePassword(32),
    hashPassword: async (pw) => bcrypt.hash(pw, 12),
    patchSecret: async ({ namespace, name, stringData }) => {
      // @kubernetes/client-node v1.x defaults to application/json-patch+json
      // for patch calls (see CoreV1Api.patchNamespacedSecret in the
      // generated code). So we send a JSON-Patch operation list of
      // `replace`s, one per key, with base64-encoded values (the Secret
      // resource stores `data` not `stringData` on the wire).
      const ops = Object.entries(stringData).map(([k, v]) => ({
        op: 'replace' as const,
        path: `/data/${k}`,
        value: Buffer.from(v, 'utf8').toString('base64'),
      }));
      // `body` is typed `any` on the generated API; a JSON Patch array
      // matches the default content-type correctly.
      await core.patchNamespacedSecret({ namespace, name, body: ops as unknown as object });
    },
    restartStatefulSet: async ({ namespace, name }) => {
      // `replace` only works if the annotation already exists; on fresh
      // resources we need `add` (which also replaces if present). Send
      // both paths so it works regardless of prior state.
      const now = new Date().toISOString();
      const body = [
        { op: 'add', path: '/spec/template/metadata/annotations', value: {} },
        { op: 'add', path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt', value: now },
      ];
      await apps.patchNamespacedStatefulSet({ namespace, name, body: body as unknown as object });
    },
    restartDeployment: async ({ namespace, name }) => {
      const now = new Date().toISOString();
      const body = [
        { op: 'add', path: '/spec/template/metadata/annotations', value: {} },
        { op: 'add', path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt', value: now },
      ];
      await apps.patchNamespacedDeployment({ namespace, name, body: body as unknown as object });
    },
    waitForStatefulSetReady: async ({ namespace, name, timeoutMs }) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const res = await apps.readNamespacedStatefulSet({ namespace, name });
        const spec = res.spec?.replicas ?? 1;
        const ready = res.status?.readyReplicas ?? 0;
        const updated = res.status?.updatedReplicas ?? 0;
        if (ready === spec && updated === spec && res.status?.observedGeneration === res.metadata?.generation) {
          return;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      // The Secret has already been patched at this point. Surface that
      // fact in the error so the server-side log tells the operator what
      // state to recover from (old password is gone; platform-api hasn't
      // been restarted yet, so it still has stale env).
      throw new Error(
        `StatefulSet ${namespace}/${name} did not become Ready within ${timeoutMs}ms. ` +
          'stalwart-secrets has already been updated; once Stalwart is healthy, manually restart platform-api to pick up the new password.',
      );
    },
    waitForDeploymentReady: async ({ namespace, name, timeoutMs }) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const res = await apps.readNamespacedDeployment({ namespace, name });
        const spec = res.spec?.replicas ?? 1;
        const ready = res.status?.readyReplicas ?? 0;
        const updated = res.status?.updatedReplicas ?? 0;
        if (ready === spec && updated === spec && res.status?.observedGeneration === res.metadata?.generation) {
          return;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(
        `Deployment ${namespace}/${name} did not become Ready within ${timeoutMs}ms. ` +
          'The rollout is in flight; check pod status directly (kubectl rollout status) and restart if needed.',
      );
    },
    verifyCredentials: async ({ host, port, username, password }) => {
      const url = `http://${host}:${port}/api/oauth`;
      const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify({ type: 'code', client_id: 'webadmin', redirect_uri: null }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        return res.status === 200;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}
