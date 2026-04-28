/**
 * Zrok provider — API contract.
 *
 * Customer-managed zrok controllers (BYO). Default URL is the public
 * https://api.zrok.io controller, but operators may register a
 * self-hosted zrok-controller — the contract makes the controllerUrl
 * field always required so customers explicitly choose between hosted
 * and self-hosted.
 *
 * Used by the deployment-level Network Access feature (mode C: zrok
 * private share). Each provider holds the credentials needed for the
 * platform-side zrok-frontdoor pod to enable a private share on the
 * customer's account.
 */
import { z } from 'zod';

export const ZROK_DEFAULT_CONTROLLER_URL = 'https://api.zrok.io';

export const zrokProviderInputSchema = z.object({
  name: z.string().min(1).max(120),
  /** Default https://api.zrok.io for hosted; full URL for self-hosted. */
  controllerUrl: z.string().url(),
  /**
   * zrok account email (used for auth + display). Stored plaintext.
   */
  accountEmail: z.string().email(),
  /**
   * zrok account token (stored encrypted). Required on create;
   * optional on update (omitted = keep current).
   */
  accountToken: z.string().min(1).optional(),
});
export type ZrokProviderInput = z.infer<typeof zrokProviderInputSchema>;

export const zrokProviderResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  controllerUrl: z.string(),
  accountEmail: z.string(),
  /** Whether a token is on file (presence-only; never returned). */
  tokenSet: z.boolean(),
  /** Number of deployments that reference this provider. */
  consumerCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ZrokProviderResponse = z.infer<typeof zrokProviderResponseSchema>;

export const zrokProviderTestResponseSchema = z.object({
  ok: z.boolean(),
  controllerReachable: z.boolean(),
  /** zrok controller version, if returned by /v1/version. */
  version: z.string().nullable(),
  error: z.string().nullable(),
});
export type ZrokProviderTestResponse = z.infer<typeof zrokProviderTestResponseSchema>;
