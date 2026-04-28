/**
 * OpenZiti provider — API contract.
 *
 * Customer-managed Ziti controllers used by the deployment-level
 * Network Access feature (mode A: tunneler). One provider per
 * (client, controller). Multiple deployments can reuse the same
 * provider — e.g. all of a customer's apps reachable via the same
 * Ziti network share one enrollment JWT.
 *
 * The enrollment JWT is a one-shot token issued by the Ziti
 * controller's enrollment endpoint; it mints a long-lived client
 * cert when first consumed by ziti-edge-tunnel. We store the JWT
 * encrypted at rest (using OIDC_ENCRYPTION_KEY for v1) and pass it
 * to the tunnel pod via mounted Secret.
 */
import { z } from 'zod';

export const zitiProviderInputSchema = z.object({
  name: z.string().min(1).max(120),
  controllerUrl: z.string().url(),
  /**
   * Ziti enrollment JWT. Required on create; optional on update
   * (omitted = keep current). One-shot token — the Ziti controller
   * invalidates it the first time the tunnel consumes it.
   */
  enrollmentJwt: z.string().min(1).optional(),
});
export type ZitiProviderInput = z.infer<typeof zitiProviderInputSchema>;

export const zitiProviderResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  controllerUrl: z.string(),
  /** True when an enrollment JWT (or post-enrollment cert) is on file. */
  enrolled: z.boolean(),
  /**
   * Enrollment cert expiry (set after first consumption). Null until
   * the tunnel reports back a successful enrollment.
   */
  certExpiresAt: z.string().nullable(),
  /** Number of deployments that reference this provider. */
  consumerCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ZitiProviderResponse = z.infer<typeof zitiProviderResponseSchema>;

export const zitiProviderTestResponseSchema = z.object({
  ok: z.boolean(),
  controllerReachable: z.boolean(),
  /** Pulled from /.well-known/est/cacerts when reachable. */
  caBundleBytes: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type ZitiProviderTestResponse = z.infer<typeof zitiProviderTestResponseSchema>;
