import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  applyMailServerHostnameToStalwart,
  getWebmailSettings,
  updateWebmailSettings,
  withMailHostnameLock,
} from './service.js';
import { updateWebmailSettingsSchema } from '@k8s-hosting/api-contracts';
import { reconcileOutboundConfig } from '../email-outbound/service.js';
import {
  reconcileWebmailIngress,
  reconcileEngineDeployments,
  waitForActiveEngineReady,
} from '../webmail-router/reconciler.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs } from '../../db/schema.js';
import * as tasks from '../tasks/service.js';
import { toSafeText } from '@k8s-hosting/api-contracts';
import type { JwtPayload } from '../../middleware/auth.js';
import crypto from 'node:crypto';

interface FlipStep {
  readonly name: string;
  state: 'pending' | 'running' | 'done' | 'failed';
}

// 5 deterministic steps the operator sees in the progress modal.
// Order matters — each step must complete before the next runs.
const FLIP_STEP_KEYS = [
  'persist',          // 1. DB row already persisted in the synchronous path
  'ingress',          // 2. flip platform-webmail-ingress services[0].name
  'mutex',            // 3. scale + annotate active/inactive Deployments
  'wait_ready',       // 4. wait for active engine pod to report ready
  'verify_url',       // 5. HTTPS probe webmail.<apex> returns 200
] as const;
type FlipStepKey = (typeof FLIP_STEP_KEYS)[number];

function makeFlipSteps(): FlipStep[] {
  return [
    { name: 'Persist engine setting',         state: 'done' as const },
    { name: 'Flip IngressRoute target',       state: 'pending' as const },
    { name: 'Scale engine Deployments',       state: 'pending' as const },
    { name: 'Wait for active engine ready',   state: 'pending' as const },
    { name: 'Verify webmail URL serves SPA',  state: 'pending' as const },
  ];
}

function pctForStep(stepIdx: number): number {
  // 5 steps → 20, 40, 60, 80, 100.
  return Math.min(100, Math.round(((stepIdx + 1) / FLIP_STEP_KEYS.length) * 100));
}

export async function webmailSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Phase 3.A.1: k8s tenant for cert provisioning. Created once at
  // plugin registration, not per-request.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'webmail-settings: k8s tenant unavailable — mail cert provisioning disabled');
    k8s = undefined;
  }

  // GET /api/v1/admin/webmail-settings
  app.get('/admin/webmail-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Get platform webmail settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await getWebmailSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/webmail-settings
  app.patch('/admin/webmail-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Update platform webmail settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = updateWebmailSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // 2026-05-09: mailServerHostname is editable post-bootstrap.
    // Stalwart 0.16's Bootstrap object is a transient install-only
    // singleton (not "locked" — empirically confirmed it returns
    // notFound after install). The runtime hostname source-of-truth
    // is `SystemSettings.defaultHostname`, which drives BOTH inbound
    // listener banners AND outbound EHLO uniformly via
    // `MtaConnectionStrategy`'s null-fallback path.
    //
    // Update flow when the operator submits a new hostname:
    //   1. Push the new value to Stalwart via JMAP first. If Stalwart
    //      rejects (validation, missing Domain row, network), we
    //      DON'T persist to platform_settings — that prevents the
    //      DB row from drifting ahead of the running server.
    //   2. Only after Stalwart accepts do we save the platform_settings
    //      row, so subsequent reads stay consistent with what the
    //      live mail server is announcing.
    //
    // Operator-side caveats (NOT enforced here, NOT auto-applied):
    //   - The cert SAN must include the new hostname for STARTTLS to
    //     match. Stalwart re-issues only when the Domain row's
    //     subjectAlternativeNames is updated and the ACME loop fires.
    //   - DNS MX + A records must point at the cluster.
    //   - Reverse DNS / FCrDNS at the IP-provider level for outbound
    //     deliverability.
    // Returning the previous value in the response gives the operator
    // a confirmation handle for rollback.
    let stalwartUpdate:
      | {
          defaultDomainId: string;
          previousHostname: string;
          rolloutTriggered: boolean;
          sanAdded: boolean;
        }
      | undefined;

    // Hostname change path is locked end-to-end (advisory xact lock)
    // so concurrent PATCHes serialize. The non-hostname path stays
    // unlocked — defaultWebmailUrl + emailSendRateLimitDefault are
    // independent rows where last-write-wins is acceptable.
    const settings = await withMailHostnameLock(app.db, async () => {
      if (parsed.data.mailServerHostname !== undefined) {
        try {
          stalwartUpdate = await applyMailServerHostnameToStalwart(
            parsed.data.mailServerHostname,
            k8s,
          );
        } catch (err) {
          throw new ApiError(
            'MAIL_HOSTNAME_APPLY_FAILED',
            `Failed to update Stalwart's defaultHostname: ${
              err instanceof Error ? err.message : String(err)
            }. The platform-settings DB row was NOT updated to keep it consistent with the live server.`,
            502,
            { field: 'mailServerHostname' },
          );
        }
      }
      return updateWebmailSettings(app.db, parsed.data);
    });

    if (stalwartUpdate) {
      app.log.info(
        {
          previousHostname: stalwartUpdate.previousHostname,
          newHostname: parsed.data.mailServerHostname,
          defaultDomainId: stalwartUpdate.defaultDomainId,
          rolloutTriggered: stalwartUpdate.rolloutTriggered,
          sanAdded: stalwartUpdate.sanAdded,
        },
        'mail-server-hostname: Stalwart SystemSettings.defaultHostname updated',
      );
      if (!stalwartUpdate.rolloutTriggered && stalwartUpdate.previousHostname !== parsed.data.mailServerHostname) {
        app.log.warn(
          { newHostname: parsed.data.mailServerHostname },
          'mail-server-hostname: pod rollout NOT triggered — operator should run `kubectl -n mail rollout restart deploy stalwart-mail` so banners pick up the new hostname',
        );
      }
      // Persist a queryable audit record so a forensic review of "who
      // renamed the mail hostname and when" has a discoverable answer.
      // Mail-hostname changes affect SMTP banners, cert SAN
      // requirements, and outbound deliverability for all tenants —
      // structured logs alone (which rotate) aren't sufficient.
      try {
        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: (request.user as { sub?: string } | undefined)?.sub ?? 'system',
          actorType: 'user',
          actionType: 'platform_settings.mail_hostname_rename',
          resourceType: 'platform_settings',
          resourceId: 'mail_server_hostname',
          changes: {
            previousHostname: stalwartUpdate.previousHostname,
            newHostname: parsed.data.mailServerHostname,
            defaultDomainId: stalwartUpdate.defaultDomainId,
          } as unknown as Record<string, unknown>,
        });
      } catch (err) {
        // Don't fail the rename if audit-log insert hits a transient
        // DB error — the rename itself already succeeded. Log loudly
        // so the operator can investigate the audit-log gap.
        app.log.error(
          { err, newHostname: parsed.data.mailServerHostname },
          'mail-server-hostname: audit_logs insert failed after successful Stalwart apply',
        );
      }
    }

    // Phase 3.B.3: if the global rate limit default was changed,
    // reconcile the Stalwart outbound config.
    if (k8s && parsed.data.emailSendRateLimitDefault !== undefined) {
      try {
        await reconcileOutboundConfig(app.db, k8s, app.log);
      } catch (err) {
        app.log.warn(
          { err },
          'webmail-settings: outbound reconcile failed (non-blocking)',
        );
      }
    }

    // 2026-05-18: if any webmail feature-visibility flag was changed,
    // re-render the override CSS ConfigMap + stamp the Deployments so
    // a rolling restart picks the new content up. Synchronous because
    // it's fast (1 ConfigMap PATCH + 2 Deployment PATCHes ≈ 500 ms);
    // the actual Pod restart is async in kube. The 5-min scheduler
    // recovers from any drift, so a failure here just delays — never
    // blocks — convergence.
    const featureFlagTouched =
      parsed.data.webmailShowContacts !== undefined
      || parsed.data.webmailShowCalendar !== undefined
      || parsed.data.webmailShowFiles !== undefined;
    if (k8s && featureFlagTouched) {
      try {
        const { reconcileWebmailFeatureCss } = await import(
          '../webmail-feature-css/reconciler.js'
        );
        await reconcileWebmailFeatureCss(
          app.db,
          { core: k8s.core, apps: k8s.apps },
          app.log,
        );
      } catch (err) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'webmail-feature-css: PATCH-triggered reconcile failed (5-min scheduler will retry)',
        );
      }
    }

    // ADR-039 Phase 10 (rev. 2026-05-18): when the operator flips the
    // webmail engine, run the actual cluster-side work in the
    // task-center so the admin UI gets a progress modal with the 5
    // checklist steps (persist / IR flip / Pod mutex / wait-ready /
    // URL verify). Returns `{ data, taskId }` immediately; the
    // background void completes in 5-30s typically (Bulwark cold-start
    // dominates).
    let flipTaskId: string | undefined;
    if (k8s && parsed.data.defaultWebmailEngine !== undefined) {
      const engine = parsed.data.defaultWebmailEngine;
      const u = request.user as JwtPayload | undefined;
      const userId = u?.sub ?? null;
      if (userId) {
        try {
          const taskStart = await tasks.start(app.db, {
            kind: 'webmail.engine-flip',
            // refId = engine target so a rapid bulwark→roundcube→bulwark
            // flip dedupes against the same target row in the chip; the
            // task is restarted cleanly on each new direction.
            //
            // KNOWN RACE: an operator can flip to engine A, see it's
            // slow, then flip to engine B before A's background void
            // finishes. Both voids run in parallel; the A-void's
            // wait_ready/verify_url steps will run against engine B
            // (which is now active per the DB) and time out → A's
            // task lands `failed` even though net intent succeeded.
            // Reconcilers are idempotent so the cluster converges
            // correctly. Acceptable trade-off vs adding a process-wide
            // mutex; the periodic scheduler also re-converges.
            refId: `engine:${engine}`,
            scope: 'admin',
            userId,
            label: toSafeText(`Switching webmail engine to ${engine}`),
            target: { type: 'modal', modal: 'mail-operation', modalProps: {} },
            progressPct: pctForStep(0),
            progressText: toSafeText('Engine setting persisted'),
            details: { steps: makeFlipSteps(), engine },
          });
          flipTaskId = taskStart.id;
        } catch (err) {
          app.log.warn(
            { err },
            'webmail-settings: task-center start failed — proceeding without progress modal',
          );
        }
      } else {
        // userId missing — auth middleware should prevent this, but be
        // explicit if a future code path slips through. The cluster
        // flip still happens via the background void below; only the
        // operator's progress modal is skipped.
        app.log.warn(
          { engine },
          'webmail-settings: engine flip without authenticated userId — skipping task-center progress modal',
        );
      }

      // Background void — runs the cluster-side flip + reports to the
      // task. Errors are captured into the task's `failed` status so
      // the operator sees them; we never throw out of this background
      // promise because the HTTP response is already sent.
      const k8sLocal = k8s;
      const taskIdLocal = flipTaskId;
      void (async () => {
        const runStep = async (
          stepIdx: number,
          stepKey: FlipStepKey,
          textRunning: string,
          textDone: string,
          fn: () => Promise<void>,
        ) => {
          const steps = makeFlipSteps();
          for (let i = 0; i < stepIdx; i++) steps[i].state = 'done';
          steps[stepIdx].state = 'running';
          if (taskIdLocal) {
            await tasks.progress(app.db, taskIdLocal, {
              pct: pctForStep(stepIdx - 1),
              text: toSafeText(textRunning),
              detailsPatch: { steps, currentStep: stepKey },
            });
          }
          await fn();
          steps[stepIdx].state = 'done';
          if (taskIdLocal) {
            await tasks.progress(app.db, taskIdLocal, {
              pct: pctForStep(stepIdx),
              text: toSafeText(textDone),
              detailsPatch: { steps },
            });
          }
        };

        try {
          await runStep(1, 'ingress', 'Flipping IngressRoute…', `IngressRoute now targets ${engine}`, async () => {
            await reconcileWebmailIngress(app.db, k8sLocal.custom, app.log);
          });
          await runStep(2, 'mutex', 'Scaling engine Deployments…', 'Engine mutex applied', async () => {
            await reconcileEngineDeployments(app.db, k8sLocal.apps, app.log);
            // 2026-05-18: re-target every per-tenant webmail.<clientdomain>
            // ExternalName Service to the new engine in the same step.
            // Without this, per-tenant routes keep pointing at the now-
            // scaled-to-0 inactive engine until the periodic reconciler
            // catches up (up to 5 minutes). The reconciler is idempotent
            // and label-cheap (no rewrite on no-drift rows).
            const { reconcilePerTenantWebmailEngineRouting } = await import(
              '../email-domains/webmail-reconciler.js'
            );
            await reconcilePerTenantWebmailEngineRouting(app.db, k8sLocal);
          });
          await runStep(3, 'wait_ready', 'Waiting for active engine to be ready…', 'Active engine has ≥1 ready Pod', async () => {
            const r = await waitForActiveEngineReady(app.db, k8sLocal.apps, { timeoutMs: 180_000 });
            if (!r.ready) {
              throw new Error(`Active engine did not become ready within ${Math.round(r.elapsedMs / 1000)}s`);
            }
          });
          await runStep(4, 'verify_url', 'Probing webmail URL…', 'Webmail URL serves the new engine', async () => {
            const { getDefaultWebmailUrl } = await import('./service.js');
            const url = await getDefaultWebmailUrl(app.db);
            // Best-effort HEAD/GET — never block on a self-signed cert
            // (dev cluster cert chain may not be trusted by Node).
            try {
              const u = new URL(url.endsWith('/') ? url : `${url}/`);
              const mod = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
              await new Promise<void>((resolve, reject) => {
                const req = mod.request(
                  {
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
                    path: u.pathname,
                    method: 'GET',
                    rejectUnauthorized: false,
                  },
                  (res) => {
                    // 200, 302, 303 all count — 5xx fails.
                    if (res.statusCode && res.statusCode < 500) resolve();
                    else reject(new Error(`Webmail URL returned HTTP ${res.statusCode}`));
                    res.resume();
                  },
                );
                req.on('error', reject);
                req.setTimeout(10_000, () => req.destroy(new Error('Webmail URL probe timed out')));
                req.end();
              });
            } catch (err) {
              throw new Error(
                `Webmail URL probe failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          });
          if (taskIdLocal) {
            await tasks.finish(app.db, taskIdLocal, {
              status: 'succeeded',
              text: toSafeText(`Webmail engine is now ${engine}`),
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.warn(
            { err: message, engine, taskId: taskIdLocal },
            'webmail-settings: engine flip background task failed',
          );
          if (taskIdLocal) {
            // Wrap the finish call in its own try/catch — if the DB is
            // down (the very thing that just made the cluster work
            // fail), an unhandled rejection here would orphan the row
            // in `running` forever, hanging the operator's progress
            // modal until the cleanup reaper fires (hours later).
            try {
              await tasks.finish(app.db, taskIdLocal, {
                status: 'failed',
                error: message.slice(0, 4096),
                text: toSafeText('Engine flip failed — see error'),
              });
            } catch (finishErr) {
              app.log.error(
                { err: finishErr instanceof Error ? finishErr.message : String(finishErr), taskId: taskIdLocal },
                'webmail-settings: tasks.finish(failed) ALSO failed — task row orphaned until cleanup reaper',
              );
            }
          }
        }
      })();
    }

    // Return the (newly persisted) settings + taskId for the
    // frontend's progress modal. Synchronous response.
    if (flipTaskId) {
      return success({ ...settings, taskId: flipTaskId });
    }
    return success(settings);
  });

  // 2026-05-07: POST /admin/mail/certificate/ensure removed.
  //
  // The endpoint provisioned a cert-manager Certificate CR for the
  // Stalwart mail hostname — that path was the v0.15 architecture
  // where the Stalwart pod mounted the resulting Secret. Cut 3
  // moved Stalwart cert lifecycle into Stalwart itself
  // (Bootstrap.requestTlsCertificate=true + AcmeProvider Http01),
  // so a cert-manager Cert CR for the mail hostname is no longer
  // mounted anywhere — calling this endpoint produced a Cert
  // resource Stalwart didn't observe, masking the real issue
  // (Stalwart's own ACME loop) when operators thought they were
  // re-issuing.
  //
  // Operators triggering manual cert re-issue now use:
  //   1. Inspect: GET /admin/email-settings/ssl-status
  //   2. Update Domain.certificateManagement.subjectAlternativeNames
  //      via the Stalwart admin UI (or stalwart-cli)
  //   3. POST Action=ReloadTlsCertificates + roll the pod if needed
  //
  // The corresponding ensureMailServerCertificate() in
  // certificates/service.ts is now dead code; flagged for removal
  // in the next v0.15 cleanup pass.
}
