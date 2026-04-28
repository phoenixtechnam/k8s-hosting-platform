/**
 * Deployment-level Network Access — API contract.
 *
 * Controls how a deployment is reachable on the network. Three modes:
 *
 *   - 'public'  (default): deployment is reached via its standard
 *                          public Ingress + LE cert. No additional
 *                          machinery.
 *   - 'tunneler': deployment is advertised as a Ziti service via a
 *                 ziti-edge-tunnel pod in bind mode in the client
 *                 namespace. The public Ingress for every route
 *                 pointing at this deployment is suppressed —
 *                 hostnames resolve only on the Ziti mesh and end
 *                 users must run a Ziti tunneler.
 *   - 'zrok':     deployment is exposed via a private zrok share
 *                 brokered by a zrok-frontdoor pod in the client
 *                 namespace. Public Ingress STAYS up but the
 *                 frontdoor enforces a valid zrok identity from the
 *                 caller; unauthenticated callers receive 403.
 *
 * Mode is mutually exclusive per deployment. Switching modes is a
 * reconciler-driven operation that idempotently tears down the
 * previous mode's resources and provisions the new one.
 *
 * This concern lives at the deployment level (not per-ingress)
 * because all three modes are about how the *app itself* is reached;
 * a deployment with three ingress routes makes one decision.
 */
import { z } from 'zod';

export const networkAccessModeSchema = z.enum(['public', 'tunneler', 'zrok']);
export type NetworkAccessMode = z.infer<typeof networkAccessModeSchema>;

/**
 * Per-deployment config. Mode discriminates which provider FK + extra
 * fields are required; validation rejects mismatched combos (e.g.
 * mode='tunneler' without zitiProviderId).
 */
export const deploymentNetworkAccessInputSchema = z
  .object({
    mode: networkAccessModeSchema,
    /** Required when mode='tunneler'. */
    zitiProviderId: z.string().nullable().optional(),
    /** Required when mode='tunneler'. The Ziti service name to bind. */
    zitiServiceName: z.string().min(1).max(255).nullable().optional(),
    /** Required when mode='zrok'. */
    zrokProviderId: z.string().nullable().optional(),
    /**
     * Required when mode='zrok'. The zrok share token (the bit after
     * `zrok access private <token>`).
     */
    zrokShareToken: z.string().min(1).max(255).nullable().optional(),
    /**
     * Forwarded as identity headers to the upstream app:
     *  - mode=tunneler: X-Ziti-Identity, X-Ziti-Identity-Roles
     *  - mode=zrok: X-Zrok-Identity
     * Public mode: ignored.
     */
    passIdentityHeaders: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'tunneler') {
      if (!val.zitiProviderId) {
        ctx.addIssue({
          code: 'custom',
          path: ['zitiProviderId'],
          message: 'zitiProviderId is required when mode is "tunneler"',
        });
      }
      if (!val.zitiServiceName) {
        ctx.addIssue({
          code: 'custom',
          path: ['zitiServiceName'],
          message: 'zitiServiceName is required when mode is "tunneler"',
        });
      }
    }
    if (val.mode === 'zrok') {
      if (!val.zrokProviderId) {
        ctx.addIssue({
          code: 'custom',
          path: ['zrokProviderId'],
          message: 'zrokProviderId is required when mode is "zrok"',
        });
      }
      if (!val.zrokShareToken) {
        ctx.addIssue({
          code: 'custom',
          path: ['zrokShareToken'],
          message: 'zrokShareToken is required when mode is "zrok"',
        });
      }
    }
  });
export type DeploymentNetworkAccessInput = z.infer<typeof deploymentNetworkAccessInputSchema>;

export const deploymentNetworkAccessResponseSchema = z.object({
  deploymentId: z.string(),
  mode: networkAccessModeSchema,
  zitiProviderId: z.string().nullable(),
  zitiServiceName: z.string().nullable(),
  zrokProviderId: z.string().nullable(),
  zrokShareToken: z.string().nullable(),
  passIdentityHeaders: z.boolean(),
  /**
   * True when the per-client mesh proxy pod (ziti-edge-tunnel or
   * zrok-frontdoor) has been provisioned successfully. Set by the
   * reconciler.
   */
  provisioned: z.boolean(),
  lastError: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
  /**
   * True when the public Ingress for routes pointing at this
   * deployment is suppressed. Mirrors the underlying state flag so
   * the UI can show "public hostname offline" badges.
   */
  publicIngressSuppressed: z.boolean(),
});
export type DeploymentNetworkAccessResponse = z.infer<typeof deploymentNetworkAccessResponseSchema>;
