/**
 * F5 — CrowdSec Console enrollment wrappers.
 *
 * Thin wrappers around `cscli console {status,enroll,disenroll}`
 * executed inside the CrowdSec pod via the shared cscliExec helper.
 * The meta-flag check (platform_settings → security.crowdsec.console_visible)
 * gates every mutating call so airgapped operators can disable the
 * surface even from super_admin accounts.
 *
 * `cscli console status -o json` output across recent CrowdSec versions
 * is unstable enough that we parse defensively and also return the raw
 * stdout in the response — see crowdsec-console.ts contracts.
 */

import type * as k8s from '@kubernetes/client-node';
import type {
  CrowdsecConsoleEnrollRequest,
  CrowdsecConsoleStatus,
} from '@k8s-hosting/api-contracts';
import { cscliExec, findCrowdsecPodName } from './cscli-exec.js';
import { createKubeConfig } from '../container-console/service.js';

/** Default CrowdSec Console URL — operators with a self-hosted Console
 * equivalent (rare) can point at a different host via their CrowdSec
 * config; we surface whatever `cscli console status` reports. */
const DEFAULT_CONSOLE_URL = 'https://app.crowdsec.net';

interface CscliConsoleFeatureRaw {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly Name?: string;
  readonly Enabled?: boolean;
}

interface CscliConsoleStatusJson {
  readonly enrolled?: boolean;
  readonly console_url?: string;
  readonly features?: ReadonlyArray<CscliConsoleFeatureRaw>;
  // Older versions may use these alternative shapes; we try them all.
  readonly Enrolled?: boolean;
  readonly URL?: string;
  readonly Options?: ReadonlyArray<CscliConsoleFeatureRaw>;
}

const parseConsoleStatus = (
  raw: string,
): Pick<CrowdsecConsoleStatus, 'enrolled' | 'consoleUrl' | 'features'> => {
  // Default to NOT enrolled — fail-closed so a parse error doesn't
  // confuse the UI into thinking the platform is enrolled.
  const defaults = { enrolled: false, consoleUrl: null as string | null, features: [] as Array<{ name: string; enabled: boolean }> };
  const trimmed = raw.trim();
  if (!trimmed) return defaults;

  let parsed: CscliConsoleStatusJson | null = null;
  try {
    parsed = JSON.parse(trimmed) as CscliConsoleStatusJson;
  } catch {
    // Older cscli versions print human-readable text. Look for the word
    // "enrolled" with a positive verb nearby — falls back to "not enrolled"
    // if the structure isn't recognised.
    const lower = trimmed.toLowerCase();
    if (lower.includes('not enrolled') || lower.includes('not registered')) {
      return defaults;
    }
    if (lower.includes('enrolled') || lower.includes('registered')) {
      return { enrolled: true, consoleUrl: DEFAULT_CONSOLE_URL, features: [] };
    }
    return defaults;
  }

  if (!parsed) return defaults;
  const enrolled = parsed.enrolled === true || parsed.Enrolled === true;
  const consoleUrl = parsed.console_url ?? parsed.URL ?? (enrolled ? DEFAULT_CONSOLE_URL : null);
  const rawFeatures: ReadonlyArray<CscliConsoleFeatureRaw> = parsed.features ?? parsed.Options ?? [];
  const features = rawFeatures
    .map((f) => ({
      name: (f.name ?? f.Name ?? '').toString(),
      enabled: f.enabled === true || f.Enabled === true,
    }))
    .filter((f) => f.name.length > 0);
  return { enrolled, consoleUrl, features };
};

export const getConsoleStatus = async (
  kubeconfigPath: string | undefined,
  metaEnabled: boolean,
): Promise<CrowdsecConsoleStatus> => {
  if (!metaEnabled) {
    return {
      enrolled: false,
      consoleUrl: null,
      metaEnabled: false,
      features: [],
      rawStatus: '(disabled by platform meta-flag — set platform_settings security.crowdsec.console_visible=true to enable)',
    };
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  let raw = '';
  let parseBlock: Pick<CrowdsecConsoleStatus, 'enrolled' | 'consoleUrl' | 'features'> = {
    enrolled: false,
    consoleUrl: null,
    features: [],
  };
  try {
    const { stdout } = await cscliExec(kc, podName, ['console', 'status', '-o', 'json']);
    raw = stdout;
    parseBlock = parseConsoleStatus(stdout);
  } catch (err) {
    // cscli returns non-zero when not enrolled on some versions. Fall
    // back to parsing whatever the error message contains; consider
    // not-enrolled as the safe default.
    raw = err instanceof Error ? err.message : String(err);
  }
  return {
    enrolled: parseBlock.enrolled,
    consoleUrl: parseBlock.consoleUrl,
    metaEnabled: true,
    features: parseBlock.features,
    rawStatus: raw,
  };
};

/**
 * Enroll the platform's CrowdSec instance with the upstream Console.
 * Returns the freshly-fetched status so the UI can render the new
 * enrolled state without a second round-trip.
 */
export const enrollConsole = async (
  kubeconfigPath: string | undefined,
  metaEnabled: boolean,
  req: CrowdsecConsoleEnrollRequest,
  actor: string,
): Promise<CrowdsecConsoleStatus> => {
  if (!metaEnabled) {
    throw new ConsoleMetaDisabledError();
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  const args: string[] = ['console', 'enroll'];
  if (req.name) {
    args.push('--name', req.name);
  }
  if (req.overwrite) {
    args.push('--overwrite');
  }
  args.push(req.enrollKey);
  // Log with the key REDACTED — never write the enrollment secret to
  // the audit trail. Actor + (optional) name are sufficient context.
  try {
    await cscliExec(kc, podName, args);
  } catch (err) {
    throw new Error(
      `cscli console enroll failed (actor=${actor}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return getConsoleStatus(kubeconfigPath, metaEnabled);
};

export const disenrollConsole = async (
  kubeconfigPath: string | undefined,
  metaEnabled: boolean,
  actor: string,
): Promise<CrowdsecConsoleStatus> => {
  if (!metaEnabled) {
    throw new ConsoleMetaDisabledError();
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  try {
    // -y bypasses the confirmation prompt cscli emits otherwise.
    await cscliExec(kc, podName, ['console', 'disenroll', '-y']);
  } catch (err) {
    throw new Error(
      `cscli console disenroll failed (actor=${actor}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return getConsoleStatus(kubeconfigPath, metaEnabled);
};

export class ConsoleMetaDisabledError extends Error {
  constructor() {
    super('CrowdSec Console is disabled by the platform meta-flag (security.crowdsec.console_visible=false)');
    this.name = 'ConsoleMetaDisabledError';
  }
}
