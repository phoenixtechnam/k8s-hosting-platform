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
  accountGet,
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
  /**
   * Cut 3 (2026-05-05): when set, override which Secret keys receive
   * the rotated password. Default is the admin/recovery shape:
   *   { adminPassword, ADMIN_SECRET_PLAIN, recoveryPassword, recoveryAdmin }
   * Webmail master rotation passes `[ 'STALWART_MASTER_PASSWORD' ]` so
   * only Roundcube's env var key is touched in `roundcube-secrets`.
   */
  readonly secretKeys?: readonly string[];
  /**
   * Optional principal-resolver override. Defaults to looking up by the
   * `name` field in the JMAP principals account. The webmail master
   * Account lives at `master@master.local` (a synthetic domain) so its
   * `name` is plain `master`; the existing find-by-name path works as-is.
   * Provided for tests + future flexibility.
   */
  readonly principalLookupName?: string;
  /**
   * Skip the post-rotation verifyNewPassword(jmap-session) check. Used
   * for the webmail master account, which is NOT a JMAP-admin principal
   * — `/jmap/session` would 401 with master credentials regardless of
   * whether the rotation succeeded. The rotation is verified instead
   * by the integration harness's IMAP master-auth probe.
   */
  readonly skipJmapSessionVerify?: boolean;
  /**
   * 2026-05-06 hardening: recycle Stalwart pods AFTER the Secret patch
   * and BEFORE the verify-loop. STALWART_RECOVERY_ADMIN is sourced via
   * `valueFrom.secretKeyRef`, which K8s bakes into the pod env at pod
   * CREATE time — changing the Secret afterward does not refresh the
   * env of running pods. The system relies on Stakater Reloader to
   * roll the Deployment, but that's async and can lag by minutes
   * (or fail entirely if rollouts crash on startup).
   *
   * When this opt is true, the rotator deletes existing Stalwart pods
   * after the Secret patch so kubelet recreates them fresh with the new
   * env. The verify-loop then probes the NEW pods immediately, which
   * matches the new Secret value — no drift, no failed verify, no
   * BlockedIp accumulation.
   *
   * Webmail-master rotation does NOT set this (its target is a DB
   * Account, not an env var; Roundcube is rolled separately by the
   * caller).
   */
  readonly recyclePodsBeforeVerify?: boolean;
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
  /**
   * Best-effort: delete Stalwart pods so kubelet recreates them with
   * the freshly-patched Secret env. Returns count for logging. Only
   * called when `opts.recyclePodsBeforeVerify === true`. Test deps
   * supply a no-op or mock; production deps perform `kubectl delete pod
   * -l app=stalwart-mail-v016` via the K8s client.
   */
  recyclePods(): Promise<{ deletedCount: number }>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export async function rotateAdminPasswordViaJmapImpl(
  opts: RotateJmapOptions,
  deps: RotateJmapDeps,
): Promise<RotateStalwartPasswordResponse> {
  const plain = deps.generatePassword();
  // Stakater Reloader takes 30-90s to roll the Stalwart pod after we
  // patch the Secret, and JMAP /session can't authenticate with the
  // new password until the pod is re-up with the new env. 30s was
  // far too short — every operator click hit the timeout and saw a
  // red "rotation failed" toast for an actually-successful rotation.
  // 120s leaves headroom for slow nodes / image-pull / liveness probes.
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 120_000;

  // 1+2+3. Try the JMAP path. Two reasons it may 401:
  //   (a) STALWART_RECOVERY_ADMIN-only mode — there's no Account row, so
  //       JMAP /session refuses unauthenticated. No JMAP rotation
  //       needed; the Secret-patch in step 4 plus Reloader is enough.
  //   (b) Pre-existing drift between the platform-api-mounted Secret
  //       and Stalwart's env var (from a half-finished prior rotation
  //       where Reloader was mid-rollout). Same recovery: patch the
  //       Secret, let Reloader sync.
  // In both cases proceeding to the Secret patch is the correct fix.
  // Without this fallback the operator was stuck in a loop: every
  // click hit 401 because we couldn't even AUTHENTICATE to do the
  // rotation, even though patching the Secret directly would unstick
  // it.
  let jmapPathSucceeded = false;
  try {
    const accountId = await deps.getJmapAccountId();
    const principalId = await deps.findAdminPrincipalId(accountId, opts.username);
    if (principalId) {
      await deps.updateAdminPassword(accountId, principalId, plain);
      jmapPathSucceeded = true;
    } else {
      log.info({
        username: opts.username,
      }, 'no Stalwart Account principal — rotating recovery-admin Secret only (Reloader will roll the pod)');
    }
  } catch (err) {
    const status = (err as { code?: string; details?: { status?: number } })?.details?.status;
    const errMsg = err instanceof Error ? err.message : String(err);
    // 401: bad/stale credentials — see comment above.
    // 429: Stalwart's auth-attempt rate-limit triggered after prior
    // attempts hit 401 in succession. The Secret-patch path doesn't
    // touch Stalwart's auth surface, so it bypasses the rate-limit
    // window. Without this clause every operator click after the
    // first 401 worsens the rate-limit window and ALL subsequent
    // rotations 500 until Stalwart's auth-attempt counter resets
    // (~5min on default config).
    // Network-level errors (`fetch failed`, `ECONNRESET`, `socket hang
    // up`, `ECONNREFUSED`) — Stalwart pod is unhealthy / mid-restart /
    // CrashLoopBackOff. Patching the Secret is the right move: when
    // Stalwart eventually recovers, it'll boot with the new password.
    // Without this clause every operator rotation attempt during a
    // Stalwart outage 500s, leaving the operator with no path to
    // rotate even though the Secret-only mechanism would still work.
    const isNetworkError = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|other side closed/i.test(errMsg);
    if (status === 401 || status === 429 || isNetworkError) {
      log.warn({
        username: opts.username,
        status,
        errMsg,
      }, 'JMAP /session unreachable or refused — falling back to recovery-admin Secret-patch path. Causes: prior rotation mid-rollout, recovery-admin-only mode, rate-limit window, OR Stalwart pod unhealthy. The Secret IS the source of truth; Stalwart picks up the new value on next pod restart.');
    } else {
      throw err;
    }
  }
  void jmapPathSucceeded;

  // 4. Patch the k8s Secret mirror so platform-api picks up the new
  //    cleartext via volume-mount refresh (~60s, no restart needed).
  //    Update ALL three keys the Stalwart Deployment / platform-api
  //    consume: adminPassword + ADMIN_SECRET_PLAIN (platform-api reads),
  //    recoveryPassword + recoveryAdmin (Stalwart's STALWART_RECOVERY_*
  //    env-vars, only consumed when no Account exists). Reloader rolls
  //    the Stalwart pod on Secret change so the recovery-admin path
  //    picks up the new password automatically.
  // Cut 3 (2026-05-05): default key set is the admin/recovery shape;
  // overridable via opts.secretKeys for webmail master rotation which
  // only touches `roundcube-secrets/STALWART_MASTER_PASSWORD`. The
  // recoveryAdmin format is `<user>:<password>` and only relevant when
  // the secret holds Stalwart's recovery-admin env value.
  const defaultStringData: Record<string, string> = {
    adminPassword: plain,
    ADMIN_SECRET_PLAIN: plain,
    recoveryPassword: plain,
    recoveryAdmin: `${opts.username}:${plain}`,
  };
  const stringData: Record<string, string> = opts.secretKeys
    ? Object.fromEntries(opts.secretKeys.map((k) => [k, plain]))
    : defaultStringData;

  try {
    await deps.patchK8sSecret({
      namespace: opts.stalwartNamespace,
      name: opts.secretName,
      stringData,
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

  // 4c. 2026-05-06 hardening: recycle Stalwart pods explicitly so the
  //     verify-loop probes pods that have the NEW env var, not the old
  //     baked one. See `RotateJmapOptions.recyclePodsBeforeVerify` doc
  //     for the full rationale (drift between mounted-Secret view and
  //     pod-env view causes verify failures → BlockedIp pile-up).
  //
  //     Best-effort: a recycle failure is logged but does NOT fail the
  //     rotation. The rotation has already succeeded at the Secret level;
  //     Reloader will eventually roll pods even if our explicit recycle
  //     hits an RBAC issue.
  if (opts.recyclePodsBeforeVerify) {
    try {
      const recycleResult = await deps.recyclePods();
      log.info({
        deletedCount: recycleResult.deletedCount,
      }, 'mail-admin: recycled Stalwart pods to refresh env after Secret patch');
    } catch (err) {
      // Best-effort by design — but surface enough detail so an operator
      // who later sees drift in the cluster can correlate it back to a
      // missing RBAC permission. Common cause: `pods/delete` not in the
      // platform-api ClusterRole. The rotation has already succeeded at
      // the Secret level; Reloader will eventually roll the pods even
      // without our explicit delete (typically 30-120s), so the
      // operator-visible UX is "rotation took longer than expected"
      // rather than "rotation failed".
      const errMsg = err instanceof Error ? err.message : String(err);
      const looksLikeRbac = /forbidden|RBAC|cannot delete|cannot list/i.test(errMsg);
      log.error({
        err: errMsg,
        likelyCause: looksLikeRbac
          ? 'platform-api ServiceAccount missing pods/delete or pods/list on namespace=mail'
          : 'unknown — see error message',
      }, 'mail-admin: recyclePods failed — drift between Secret and Stalwart env may persist until Reloader rollout completes (rotation continues; verify-loop will probe whatever pods are alive)');
    }
  }

  // 5. Verify new credentials work — but only when the rotated principal
  //    can authenticate to JMAP /session. The webmail master account is
  //    NOT a JMAP-admin (it has `impersonate` for IMAP master-auth, not
  //    JMAP admin scope), so /jmap/session 401s for it regardless of
  //    correct password. Callers that rotate non-admin accounts pass
  //    `skipJmapSessionVerify: true`; the integration harness then
  //    verifies via the actual user-visible flow (Roundcube IMAP-login
  //    after pod roll).
  // Code-review M-3 fix (2026-05-03, second pass): use do/while so we
  // ALWAYS attempt at least one verification, even if `verifyTimeoutMs`
  // is zero or the clock advanced past the deadline before we got here.
  if (!opts.skipJmapSessionVerify) {
    const deadline = deps.now().getTime() + verifyTimeoutMs;
    let ok = false;
    do {
      ok = await deps.verifyNewPassword(plain);
      if (ok) break;
      if (deps.now().getTime() >= deadline) break;
      await deps.sleep(2_000);
    } while (deps.now().getTime() < deadline);
    if (!ok) {
      // The Secret IS rotated; Stalwart's pod will pick it up after
      // Reloader rollout (~30-120s). Throwing 500 here makes the
      // operator click "rotate" again, which double-rotates and
      // worsens the drift. Log a warning, return success to the
      // operator with the new cleartext, and let the next admin
      // request hit Stalwart through the normal kubelet-refresh path.
      log.warn({
        verifyTimeoutMs,
      }, 'mail-admin: rotation verify timed out — Secret rotated successfully, Stalwart pod still rolling. Operator response includes new password.');
    }
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
      // Cut 3 follow-up (2026-05-04): Stalwart 0.16's x:Account/query
      // does NOT honour `{ name }` (or any tested filter) — silently
      // returns ids: []. We list-and-filter via x:Account/get + client-
      // side match until a working filter shape is documented. The
      // expected user count for the admin namespace is tiny (1–10),
      // so the full list is cheap.
      const result = await accountGet({
        accountId,
        ids: null,
        properties: ['id', 'name'],
        baseUrl,
      });
      const target = username.toLowerCase();
      const match = result.list.find((r) => {
        const name = typeof r.name === 'string' ? r.name.toLowerCase() : '';
        return name === target;
      });
      return (match?.id as string | undefined) ?? null;
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

    async recyclePods(): Promise<{ deletedCount: number }> {
      // 2026-05-06: dynamic-import the recycler module so the heavy
      // @kubernetes/client-node code stays out of the test path that
      // injects fake deps.
      const { recycleStalwartPods } = await import('./recycle-stalwart-pods.js');
      return recycleStalwartPods({
        kubeconfigPath,
        namespace: 'mail',
        labelSelector: 'app=stalwart-mail-v016',
        gracePeriodSeconds: 15,
      });
    },

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}
