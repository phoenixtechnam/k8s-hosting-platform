/**
 * F2 — Custom allowlist (CrowdSec v1.7+ `cscli allowlists`).
 *
 * Allowlisted IPs/CIDRs are immune from ANY CrowdSec ban — community
 * blocklist, scenario hits, manual bans, F1 L4 enforcement. This is
 * the operator's "never lock me out" surface; populate it with office
 * IPs, monitoring origins, and the operator's own egress before
 * enabling F1 (L4) or F3 (auto-ban).
 *
 * Implementation: a single allowlist named `admin-panel` is auto-
 * created on first use; all entries are managed within it via
 * `cscli allowlists add/remove`. The allowlist is pulled by bouncers
 * via the same `/v1/decisions` cycle so propagation matches bans.
 *
 * Single source of truth: cscli/SQLite. We do NOT mirror entries into
 * platform_settings — operators editing via cscli directly Just Works
 * (same as decisions). The list endpoint is always live, no caching.
 */

import * as k8s from '@kubernetes/client-node';
import { createKubeConfig } from '../container-console/service.js';
import { cscliExec, findCrowdsecPodName } from './cscli-exec.js';
import type {
  CrowdsecAllowlistEntry,
  CrowdsecAddAllowlistRequest,
} from '@k8s-hosting/api-contracts';

const ALLOWLIST_NAME = 'admin-panel';
const ALLOWLIST_DESCRIPTION = 'Operator-managed allowlist via the admin panel';

/**
 * Idempotently ensure the allowlist exists. Uses `inspect` (exit code
 * driven) as the existence pre-check rather than text-matching cscli's
 * stderr — the stderr text is not a stable contract and would silently
 * break on a cscli minor upgrade. inspect's exit code IS stable: 0 if
 * the allowlist exists, non-zero otherwise.
 */
async function ensureAllowlistExists(kc: k8s.KubeConfig, podName: string): Promise<void> {
  try {
    await cscliExec(kc, podName, ['allowlists', 'inspect', ALLOWLIST_NAME, '-o', 'json']);
    return; // exists
  } catch {
    // Falls through to create.
  }
  // Create. If a concurrent caller raced us and created it first, cscli
  // returns "already exists" in stderr — accept that text match as a
  // narrow fallback (the inspect path is the primary correctness gate).
  try {
    await cscliExec(kc, podName, [
      'allowlists', 'create', ALLOWLIST_NAME,
      '--description', ALLOWLIST_DESCRIPTION,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|already present/i.test(msg)) {
      throw err;
    }
  }
}

interface CscliInspectRow {
  value?: string;
  expiration?: string | null;
  description?: string;
  created_at?: string;
}

interface CscliInspectOutput {
  name?: string;
  items?: CscliInspectRow[];
  // Newer cscli wraps under `Items` with capital I — be tolerant.
  Items?: CscliInspectRow[];
}

/**
 * Parse a cscli expiration string like "2027-05-20T00:00:00Z" into an
 * ISO datetime, or null if absent. cscli also accepts duration strings
 * ("8760h") which we don't store; we'd lose information by translating,
 * so just return null in that case.
 */
function parseExpiration(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // ISO datetime
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    try {
      return new Date(raw).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Detect IP vs CIDR scope from the value (we don't store scope per-entry
 * in cscli — it's inferred from the value).
 */
function inferScope(value: string): 'Ip' | 'Range' {
  return value.includes('/') ? 'Range' : 'Ip';
}

/**
 * `cscli allowlists` doesn't have first-class created_by/comment fields
 * per-entry — instead the comment stores `actor:reason` (similar to how
 * we tag manual bans with `admin-panel:<actor>:<reason>` in the scenario
 * field). The list endpoint splits this back out for display.
 *
 * Strip `:` from the actor part because some OIDC providers issue `sub`
 * claims that contain colons (e.g. `provider:user-id`). If we didn't
 * strip, the first-colon split in `splitEntryComment` would attribute
 * the entry to the prefix only and the rest leaks into the comment.
 * Underscore is harmless; visual inspection of the audit log still
 * shows the full actor in app.log.warn() output, just not in cscli.
 */
function buildEntryComment(actor: string, reason: string): string {
  const safeActor = actor.replace(/:/g, '_');
  return `${safeActor}:${reason}`;
}

function splitEntryComment(combined: string | undefined): { addedBy: string | null; comment: string } {
  if (!combined) return { addedBy: null, comment: '' };
  const idx = combined.indexOf(':');
  if (idx === -1) return { addedBy: null, comment: combined };
  return {
    addedBy: combined.slice(0, idx) || null,
    comment: combined.slice(idx + 1),
  };
}

export async function listAllowlistEntries(
  kubeconfigPath: string | undefined,
): Promise<CrowdsecAllowlistEntry[]> {
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  await ensureAllowlistExists(kc, podName);

  // `cscli allowlists inspect <name> -o json` returns the allowlist's
  // metadata + entries. Tolerate both camelCase and PascalCase keys
  // (cscli output format has shifted between releases).
  try {
    const { stdout } = await cscliExec(kc, podName, ['allowlists', 'inspect', ALLOWLIST_NAME, '-o', 'json']);
    const parsed = JSON.parse(stdout) as CscliInspectOutput;
    const items = parsed.items ?? parsed.Items ?? [];
    return items.map((row): CrowdsecAllowlistEntry => {
      const { addedBy, comment } = splitEntryComment(row.description);
      return {
        value: String(row.value ?? ''),
        scope: inferScope(String(row.value ?? '')),
        comment,
        addedBy,
        addedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        expiresAt: parseExpiration(row.expiration),
      };
    }).filter((e) => e.value !== '');
  } catch (err) {
    // Tolerate "allowlist is empty" — return [].
    const msg = err instanceof Error ? err.message : String(err);
    if (/empty|no items|no entries/i.test(msg)) return [];
    throw err;
  }
}

export async function addAllowlistEntry(
  kubeconfigPath: string | undefined,
  req: CrowdsecAddAllowlistRequest,
  actor: string,
): Promise<{ message: string }> {
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  await ensureAllowlistExists(kc, podName);
  const comment = buildEntryComment(actor, req.comment);
  const { stdout, stderr } = await cscliExec(kc, podName, [
    'allowlists', 'add', ALLOWLIST_NAME, req.value,
    '--comment', comment,
  ]);
  return { message: (stdout + stderr).trim().slice(0, 500) };
}

export async function removeAllowlistEntry(
  kubeconfigPath: string | undefined,
  value: string,
): Promise<{ message: string; removed: number }> {
  // Strict validation at the route layer; defence-in-depth here too.
  if (!/^[a-fA-F0-9.:/]+$/.test(value)) {
    throw new Error('invalid allowlist value');
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  const { stdout, stderr } = await cscliExec(kc, podName, [
    'allowlists', 'remove', ALLOWLIST_NAME, value,
  ]);
  const combined = (stdout + stderr).trim();
  // cscli prints either "1 element(s) removed" or similar.
  const match = combined.match(/(\d+)\s+element\(s\)/);
  const removed = match ? Number(match[1]) : 0;
  return { message: combined.slice(0, 500), removed };
}

/**
 * Used by F1 L4 PATCH guard + F3 auto-ban: check whether an IP is in any
 * CrowdSec allowlist. Returns true if found OR if the check itself
 * couldn't complete (FAIL-CLOSED for safety — refuses the dangerous
 * action when we can't verify the IP is safe to ban).
 *
 * Important: `cscli allowlists check` checks ALL allowlists registered
 * on this LAPI, not only `admin-panel`. If an operator creates extra
 * allowlists via the CLI, IPs in those will also be reported here.
 * This is by design — any allowlist should protect the IP.
 *
 * Break-glass: if the CrowdSec pod is unreachable during an emergency
 * (e.g. operator needs to flip L4 off but isIpInAllowlist fails-closed
 * → refuses the toggle), operator can delete the platform_setting key
 * directly via psql, or restart the CrowdSec pod to recover LAPI. See
 * docs/02-operations/CROWDSEC_OPS.md.
 */
export async function isIpInAllowlist(
  kubeconfigPath: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!/^[a-fA-F0-9.:/]+$/.test(ip)) return false;
  const kc = createKubeConfig(kubeconfigPath);
  let podName: string;
  try {
    podName = await findCrowdsecPodName(kc);
  } catch {
    // CrowdSec pod unreachable — fail closed: refuse the dangerous
    // action by claiming the IP IS allowlisted. Caller will skip the
    // ban / refuse the toggle.
    return true;
  }
  try {
    const { stdout, stderr } = await cscliExec(kc, podName, [
      'allowlists', 'check', ip,
    ]);
    const combined = stdout + stderr;
    return /is in allowlist|matches allowlist|is allowlisted/i.test(combined);
  } catch {
    // LAPI / cscli error — fail closed (same rationale as above).
    return true;
  }
}
