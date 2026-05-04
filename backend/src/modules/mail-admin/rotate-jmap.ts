/**
 * Stalwart 0.16 JMAP-backed admin password rotation.
 *
 * Stalwart 0.16 supports in-flight password rotation via JMAP
 * Principal/set — no pod restart needed. The new password takes effect
 * immediately on the Stalwart side.
 *
 * Steps:
 *   1. Generate a fresh random password.
 *   2. Locate the admin principal via JMAP Principal/get (name='admin').
 *   3. Update via JMAP Principal/set patch { 'secrets/0': newPassword }.
 *   4. Patch the `stalwart-admin-creds` k8s Secret so the volume-mounted
 *      file that platform-api reads is updated; kubelet refreshes it
 *      within ~60s, no platform-api restart required.
 *   5. Verify the new credentials by calling JMAP session (GET /jmap/session)
 *      with the new password. Retry until success or timeout.
 *
 * On failure after step 3 (JMAP updated but k8s Secret patch failed):
 *   - Stalwart already accepts the new password.
 *   - The k8s Secret still holds the old value; platform-api will fail
 *     to authenticate to Stalwart until the operator manually patches
 *     the secret or re-runs rotation.
 *   - The error message makes this explicit.
 */

import { randomBytes } from 'node:crypto';
import {
  getJmapSession,
  accountQuery,
  accountSet,
  type JmapAccountId,
} from '../stalwart-jmap/client.js';
import { rotateStalwartPasswordResponseSchema, type RotateStalwartPasswordResponse } from '@k8s-hosting/api-contracts';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'mail-admin-rotate' });

export interface RotateJmapOptions {
  readonly kubeconfigPath: string | undefined;
  readonly stalwartNamespace: string;
  readonly secretName: string;
  readonly username: string;
  /**
   * Optional cross-namespace mirror Secret. Used to keep the platform-
   * namespace `platform-stalwart-creds` Secret (mounted into platform-api
   * at /etc/stalwart-creds/) in sync with the rotated mail-namespace
   * `stalwart-admin-creds` Secret. Without this, platform-api would
   * keep reading the OLD password and fail to authenticate to Stalwart
   * after the next pod restart. Best-effort: a missing mirror Secret
   * is logged but does not fail the rotation.
   */
  readonly mirrorNamespace?: string;
  readonly mirrorSecretName?: string;
  /** Timeout for credential verification in ms. Default: 30s. */
  readonly verifyTimeoutMs?: number;
}

export async function rotateAdminPasswordViaJmap(
  opts: RotateJmapOptions,
): Promise<RotateStalwartPasswordResponse> {
  return rotateAdminPasswordViaJmapImpl(opts, defaultDeps(opts.kubeconfigPath));
}

// ── Dependency injection seam ─────────────────────────────────────────────────

export interface RotateJmapDeps {
  generatePassword(): string;
  getJmapAccountId(env?: NodeJS.ProcessEnv): Promise<JmapAccountId>;
  findAdminPrincipalId(accountId: JmapAccountId, username: string): Promise<string | null>;
  updateAdminPassword(accountId: JmapAccountId, principalId: string, newPassword: string): Promise<void>;
  patchK8sSecret(req: { namespace: string; name: string; stringData: Record<string, string> }): Promise<void>;
  verifyNewPassword(password: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export async function rotateAdminPasswordViaJmapImpl(
  opts: RotateJmapOptions,
  deps: RotateJmapDeps,
): Promise<RotateStalwartPasswordResponse> {
  const plain = deps.generatePassword();
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 30_000;

  // 1. Resolve JMAP account ID
  const accountId = await deps.getJmapAccountId();

  // 2. Find admin principal ID. The admin can be served two ways:
  //   (a) via STALWART_RECOVERY_ADMIN env (recovery / bootstrap mode —
  //       no Account row exists in the DB); the credential lives in
  //       the stalwart-admin-creds Secret only.
  //   (b) via a real x:Account/User principal in the DB; createMailbox
  //       puts user mailboxes here, and bootstrap installs `admin`
  //       once the cluster is past first-init.
  // For (a), JMAP rotation is impossible — there's nothing to update.
  // For (b), we issue x:Account/set to update credentials/0/secret.
  // Either way, the Secret-side patch in step 4 is what platform-api
  // and the kubelet pick up; Reloader rolls Stalwart on Secret change
  // so the recovery-admin path picks up the new password too.
  const principalId = await deps.findAdminPrincipalId(accountId, opts.username);

  // 3. If a real Account exists, update its secret via JMAP so the
  //    rotation is in-flight (no Stalwart restart). Skip cleanly when
  //    only the recovery-admin credential is in play.
  if (principalId) {
    await deps.updateAdminPassword(accountId, principalId, plain);
  } else {
    log.info({
      username: opts.username,
    }, 'no Stalwart Account principal — rotating recovery-admin Secret only (Reloader will roll the pod)');
  }

  // 4. Patch the k8s Secret mirror so platform-api picks up the new
  //    cleartext via volume-mount refresh (~60s, no restart needed).
  //    Update ALL three keys the Stalwart Deployment / platform-api
  //    consume: adminPassword + ADMIN_SECRET_PLAIN (platform-api reads),
  //    recoveryPassword + recoveryAdmin (Stalwart's STALWART_RECOVERY_*
  //    env-vars, only consumed when no Account exists). Reloader rolls
  //    the Stalwart pod on Secret change so the recovery-admin path
  //    picks up the new password automatically.
  try {
    await deps.patchK8sSecret({
      namespace: opts.stalwartNamespace,
      name: opts.secretName,
      stringData: {
        adminPassword: plain,
        ADMIN_SECRET_PLAIN: plain,
        recoveryPassword: plain,
        recoveryAdmin: `${opts.username}:${plain}`,
      },
    });
    // 4b. Mirror to the cross-namespace platform Secret if configured.
    // platform-api reads /etc/stalwart-creds/ADMIN_SECRET_PLAIN from a
    // volume mount of `platform-stalwart-creds` (same key set as the
    // mail-namespace Secret). Without this mirror, the rotated password
    // is in mail/stalwart-admin-creds but platform-api keeps reading
    // the old one. Best-effort: log + continue if the mirror Secret
    // doesn't exist on this cluster (older installs may not have it).
    if (opts.mirrorNamespace && opts.mirrorSecretName) {
      try {
        await deps.patchK8sSecret({
          namespace: opts.mirrorNamespace,
          name: opts.mirrorSecretName,
          stringData: {
            adminPassword: plain,
            ADMIN_SECRET_PLAIN: plain,
          },
        });
      } catch (mirrorErr) {
        log.warn({
          err: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
        }, 'platform-stalwart-creds mirror patch failed (non-fatal — platform-api will keep reading the old password until operator updates the mirror manually)');
      }
    }
  } catch (err) {
    // Stalwart already has the new password. Code-review MEDIUM-3 fix
    // (2026-05-03): use ApiError so the response envelope carries the
    // new plain password in `details.password` — the docstring promised
    // the operator sees it on partial failure, but a plain Error throw
    // produced a generic 500 with no payload.
    const { ApiError } = await import('../../shared/errors.js');
    throw new ApiError(
      'MAIL_PASSWORD_SECRET_PATCH_FAILED',
      `JMAP rotation succeeded but k8s Secret patch failed: ${err instanceof Error ? err.message : String(err)}`,
      500,
      {
        // The new password is ACTIVE in Stalwart. The operator must
        // capture this value before retrying or platform-api will
        // become unable to auth.
        password: plain,
        secretRef: `${opts.stalwartNamespace}/${opts.secretName}`,
      },
      `Stalwart is now using this password. Manually patch the Secret with the value in details.password OR re-run rotation; do NOT discard this response.`,
    );
  }

  // 5. Verify new credentials work.
  // Code-review M-3 fix (2026-05-03, second pass): use do/while so we
  // ALWAYS attempt at least one verification, even if `verifyTimeoutMs`
  // is zero or the clock advanced past the deadline before we got here.
  // The previous while-pre-check could throw before ever calling
  // verifyNewPassword for very-tight timeouts (especially in tests).
  const deadline = deps.now().getTime() + verifyTimeoutMs;
  let ok = false;
  do {
    ok = await deps.verifyNewPassword(plain);
    if (ok) break;
    if (deps.now().getTime() >= deadline) break;
    await deps.sleep(2_000);
  } while (deps.now().getTime() < deadline);
  if (!ok) {
    throw new Error(
      'JMAP rotation and k8s Secret patch succeeded but credential verification timed out. ' +
        'The new password is active — verify manually that Stalwart is healthy.',
    );
  }

  return rotateStalwartPasswordResponseSchema.parse({
    username: opts.username,
    password: plain,
    rotatedAt: deps.now().toISOString(),
  });
}

// ── Default production implementations ───────────────────────────────────────

/**
 * Build real deps for the production code path.
 *
 * `@kubernetes/client-node` is loaded lazily (dynamic import inside
 * `patchK8sSecret`) so the module-level import of rotate-jmap.ts does NOT
 * pull in the heavy k8s package. This keeps the test worker from OOM-ing when
 * the test only exercises `rotateAdminPasswordViaJmapImpl` with injected deps.
 */
function defaultDeps(kubeconfigPath: string | undefined): RotateJmapDeps {
  const baseUrl = process.env.STALWART_MGMT_URL ?? 'http://stalwart-mgmt-v016.mail.svc.cluster.local:8080';

  return {
    generatePassword: () =>
      randomBytes(32).toString('base64url').replace(/=+$/, ''),

    async getJmapAccountId(env = process.env): Promise<JmapAccountId> {
      const session = await getJmapSession(baseUrl, env);
      const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
      if (!id) throw new Error('JMAP session has no principals account');
      return id;
    },

    async findAdminPrincipalId(accountId: JmapAccountId, username: string): Promise<string | null> {
      // Stalwart 0.16: x:Account/query supports server-side filter by
      // `name`. The standard Principal/get path doesn't exist on this
      // server; calls against it return urn:ietf:params:jmap:error:notRequest.
      const result = await accountQuery({
        accountId,
        filter: { name: username },
        baseUrl,
      });
      return result.ids[0] ?? null;
    },

    async updateAdminPassword(accountId: JmapAccountId, principalId: string, newPassword: string): Promise<void> {
      // Patch path `credentials/0/secret` mirrors the structure
      // x:Account/set expects when the User has a `credentials` map
      // with a single Password entry at index "0" — see
      // scripts/integration-stalwart-v016-local.sh for the create-side
      // shape that Stalwart accepts.
      const result = await accountSet({
        accountId,
        request: { update: { [principalId]: { 'credentials/0/secret': newPassword } } },
        baseUrl,
      });
      const notUpdated = result.notUpdated?.[principalId];
      if (notUpdated) {
        throw new Error(
          `JMAP x:Account/set update failed for admin '${principalId}': `
          + `${notUpdated.description ?? notUpdated.type}`,
        );
      }
    },

    async patchK8sSecret({ namespace, name, stringData }) {
      // Lazy-load @kubernetes/client-node so this file doesn't pull in the
      // heavy k8s bundle at import time (avoids OOM in test workers).
      const k8s = await import('@kubernetes/client-node');
      const { JSON_PATCH } = await import('../../shared/k8s-patch.js');
      const kc = new k8s.KubeConfig();
      if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
      else kc.loadFromCluster();
      const core = kc.makeApiClient(k8s.CoreV1Api);

      // Bug history (2026-05-03):
      //   - First HIGH-3 fix (855b443) misdiagnosed the SDK default and
      //     switched the body to `{ data: {...} }` merge-object — that
      //     would have failed in production because client-node 1.4 forces
      //     application/json-patch+json on the wire.
      //   - Second pass (this version) restores RFC 6902 op arrays — the
      //     body shape that matches the SDK's wire content-type — and
      //     passes JSON_PATCH explicitly so the choice is documented and
      //     the CI guard (scripts/ci-k8s-patch-check.sh) is satisfied.
      //
      // `op:'replace'` is safe because bootstrap creates the Secret data
      // keys upfront. If a future Secret keeps add semantics, switch to
      // `op:'add'` (RFC 6902 add-or-replace).
      const ops = Object.entries(stringData).map(([k, v]) => ({
        op: 'replace' as const,
        path: `/data/${k}`,
        value: Buffer.from(v, 'utf8').toString('base64'),
      }));
      await core.patchNamespacedSecret(
        { namespace, name, body: ops as unknown as object },
        JSON_PATCH,
      );
    },

    async verifyNewPassword(password: string): Promise<boolean> {
      const username = process.env.STALWART_ADMIN_USER?.trim() || 'admin';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(`${baseUrl}/jmap/session`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        return res.ok;
      } catch {
        return false;
      }
    },

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}
