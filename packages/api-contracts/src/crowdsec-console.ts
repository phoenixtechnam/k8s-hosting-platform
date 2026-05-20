/**
 * F5 — CrowdSec Console enrollment.
 *
 * The CrowdSec Console (app.crowdsec.net) is the upstream SaaS dashboard:
 * cross-cluster scenario stats, alert push notifications, the curated
 * "Console blocklists" (premium feeds), and a hosted UI for the LAPI.
 * Enrollment is OPT-IN per platform installation (default disabled in
 * platform_settings) — many operators run airgapped or have policy
 * restrictions against outbound to crowdsec.net.
 *
 * Mechanism: `cscli console enroll <enrollKey>` exchanges the key for a
 * machine identity stored in /etc/crowdsec/online_api_credentials.yaml,
 * then the LAPI process pushes alerts upstream. `cscli console
 * disenroll` removes the credentials. `cscli console status -o json`
 * surfaces current state (enrolled vs. not, console URL, features
 * enabled: alert-context, manual-decisions, console-management).
 *
 * UI surface: a dedicated card in /settings/security-hardening
 * Banned-IPs tab, super_admin only. Hidden entirely when
 * platform_settings `security.crowdsec.console_visible` is `false`
 * (airgapped meta-flag).
 */

import { z } from 'zod';

export const crowdsecConsoleFeatureSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
});
export type CrowdsecConsoleFeature = z.infer<typeof crowdsecConsoleFeatureSchema>;

export const crowdsecConsoleStatusSchema = z.object({
  /** True when /etc/crowdsec/online_api_credentials.yaml has a machine
   * identity loaded AND the LAPI process has read it successfully. */
  enrolled: z.boolean(),
  /** The console URL (https://app.crowdsec.net by default — operators
   * with a self-hosted Console-equivalent can point at a different host). */
  consoleUrl: z.string().nullable(),
  /** Whether the platform-level meta-flag is enabled. When false, the
   * UI hides the entire card; the API also refuses enroll/disenroll
   * calls so airgapped operators can't accidentally enable upstream. */
  metaEnabled: z.boolean(),
  /** Features advertised by `cscli console status -o json`. Empty when
   * not enrolled. Cosmetic — only surfaced so operators can see what
   * a freshly-enrolled instance unlocks. */
  features: z.array(crowdsecConsoleFeatureSchema),
  /** Raw stdout from cscli console status — for debugging when our
   * parser can't make sense of the structured output (cscli output
   * format has changed across minor versions historically). */
  rawStatus: z.string(),
});
export type CrowdsecConsoleStatus = z.infer<typeof crowdsecConsoleStatusSchema>;

/**
 * Operator enrolls by pasting the enroll key from app.crowdsec.net's
 * "Add Machine" page. The key is the canonical form e.g.
 * `lh7tjjpa2lmd6ku5osmd5l3dkyahw7n4dq7ovwbmhx8mtfvz`, 32-64 alnum chars.
 * We never persist the key — it's exchanged for a machine identity at
 * `cscli console enroll` time and is single-use.
 */
export const crowdsecConsoleEnrollRequestSchema = z.object({
  enrollKey: z
    .string()
    .min(16)
    .max(128)
    // Defensive char-class — cscli treats the key as an argv. Alnum +
    // dash + underscore covers the documented key format with margin.
    .regex(/^[A-Za-z0-9_-]+$/, 'enroll key must be alphanumeric (with optional - or _)'),
  /** Optional human-readable name shown on the console dashboard. */
  name: z.string().min(1).max(64).optional(),
  /** When true, sends `cscli console enroll --overwrite <key>`, replacing
   * any existing enrollment. Default false so an accidental enroll
   * against a wrong key surfaces a clear error rather than silently
   * stealing the LAPI identity. */
  overwrite: z.boolean().optional(),
});
export type CrowdsecConsoleEnrollRequest = z.infer<typeof crowdsecConsoleEnrollRequestSchema>;

/**
 * Platform-wide meta-flag toggle. When false, the UI tab is hidden
 * AND every enroll/disenroll API call returns 403 — defense in depth
 * for airgapped operators who don't want platform users (including
 * super_admin) to accidentally reach the upstream Console.
 */
export const crowdsecConsoleMetaPatchSchema = z.object({
  visible: z.boolean(),
});
export type CrowdsecConsoleMetaPatch = z.infer<typeof crowdsecConsoleMetaPatchSchema>;
