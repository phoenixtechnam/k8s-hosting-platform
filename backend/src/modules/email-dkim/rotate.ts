/**
 * Manual DKIM key rotation for a client email domain.
 *
 * Stalwart 0.16 ships with `Bootstrap.generateDkimKeys=false` (set
 * in bootstrap-plan-cm.yaml), so DKIM keys do NOT auto-rotate. The
 * client-panel offers a button per domain to trigger a manual
 * rotation when needed (annual key rotation hygiene, suspected
 * compromise, etc.).
 *
 * Rotation flow:
 *   1. Generate a new Ed25519 key pair (matches Stalwart's preferred
 *      algorithm — keys are tiny, signatures are short, broadly
 *      supported).
 *   2. Pick a new selector name `default-<yyyymmddHHmm>` so we never
 *      reuse selectors and key history is auditable from DNS.
 *   3. Create the new DkimSignature in Stalwart's config store via
 *      the mgmt API, leaving the existing signature ACTIVE
 *      (dual-signing window) so already-delivered messages continue
 *      to verify until the old DNS TXT TTL expires.
 *   4. Publish the new public key as a TXT record at
 *      `<new-selector>._domainkey.<domain>`.
 *   5. Return the new selector + public key + recommended retire
 *      date (now + 14 days = >2× typical DNS TTL) so the UI can
 *      show the operator when it's safe to deactivate the old key.
 *
 * What this does NOT do:
 *   - Automatic retirement of old keys. Operator decides when to
 *     remove the old key (after the dual-signing window) via a
 *     separate admin action (or by pruning DkimSignature rows in
 *     Stalwart manually). This is intentionally manual — auto-
 *     retirement before DNS propagation breaks signature
 *     verification on emails sitting in receivers' queues.
 *   - Re-signing of historical mail. DKIM signs at send time; a key
 *     rotation only affects new outgoing messages.
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { emailDomains, dnsRecords, domains } from '../../db/schema.js';
import { proxyStalwartRequest } from '../mail-admin/service.js';
import { syncRecordToProviders } from '../email-domains/dns-provisioning.js';
import { formatDkimDnsValue } from '../email-domains/dkim.js';

export interface RotateDkimResult {
  readonly newSelector: string;
  readonly newPublicKey: string;
  readonly txtRecordName: string;
  readonly txtRecordValue: string;
  readonly recommendedRetireOldAt: string; // ISO-8601, 14 days hence
  readonly stalwartDkimSignatureId: string;
}

export interface RotateDkimDeps {
  readonly kubeconfigPath?: string;
  /** Override the default Date.now()-based selector for tests. */
  readonly nowMs?: number;
}

export class DkimRotationError extends Error {
  constructor(message: string, readonly code: string, readonly stalwartStatus?: number) {
    super(message);
    this.name = 'DkimRotationError';
  }
}

/**
 * Generate a fresh Ed25519 key pair in PEM format.
 *
 * Ed25519 is what Stalwart's bootstrap uses (DkimSignature @type =
 * Dkim1Ed25519Sha256). Keys are 32 bytes; the public key in DNS is
 * a single ~64-char base64 string vs RSA-2048's >300 chars.
 */
export function generateDkimKeyPairEd25519(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

export function newDkimSelector(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  // YYYYMMDDhhmmss — second-precision so two operator clicks in the
  // same minute (legitimate retry) or two near-simultaneous rotations
  // across replicas don't collide on the Stalwart-side signature ID.
  // Selector format is DNS-safe (a-z, 0-9, hyphen).
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `dkim-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Apply a DkimSignature `create` plan to Stalwart's mgmt API.
 *
 * Plan format (NDJSON, one create per line):
 *   {"@type":"create","object":"DkimSignature","value":{"<id>":{...}}}
 *
 * Stalwart 0.16's apply endpoint accepts NDJSON via the `apply`
 * sub-API at POST /api/store/import (per stalwart-cli wire format,
 * verified empirically). We POST a single-line plan; Stalwart
 * persists it and the new signature is immediately available for
 * the next outgoing message.
 */
async function postDkimCreatePlan(
  kubeconfigPath: string | undefined,
  signatureId: string,
  domainId: string,
  selector: string,
  privateKeyPem: string,
): Promise<void> {
  const planLine = JSON.stringify({
    '@type': 'create',
    object: 'DkimSignature',
    value: {
      [signatureId]: {
        '@type': 'Dkim1Ed25519Sha256',
        domainId,
        selector,
        canonicalization: 'relaxed/relaxed',
        headers: { From: true, To: true, Date: true, Subject: true, 'Message-ID': true },
        privateKey: { '@type': 'Text', secret: privateKeyPem },
        report: false,
        stage: 'active',
        thirdParty: null,
        thirdPartyHash: null,
        auid: null,
        expire: null,
        memberTenantId: null,
        nextTransitionAt: null,
      },
    },
  });

  const result = await proxyStalwartRequest(
    kubeconfigPath,
    'POST',
    '/api/store/import',
    planLine + '\n',
    'application/x-ndjson',
  );

  if (result.status < 200 || result.status >= 300) {
    // SECURITY (CRITICAL): the request body included the PEM-encoded
    // private key, and Stalwart's error response can echo back the
    // submitted plan or a portion of it. Sanitise the response body
    // before surfacing to ensure the private key cannot leak into
    // platform-api logs / audit-log / error messages. Never include
    // raw response bytes that contain BEGIN PRIVATE KEY.
    const safeBody = redactPemBlocks(result.body).slice(0, 500);
    throw new DkimRotationError(
      `Stalwart rejected DkimSignature create (status ${result.status}): ${safeBody}`,
      'STALWART_API_ERROR',
      result.status,
    );
  }
}

/**
 * Strip any PEM blocks (BEGIN/END markers + body) from a string.
 * Used to scrub Stalwart-echoed error bodies that might contain
 * the just-submitted private key.
 */
function redactPemBlocks(input: string): string {
  return input.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    '[REDACTED-PEM-BLOCK]',
  );
}

/**
 * Rotate the DKIM key for the email-domain identified by emailDomainId.
 *
 * Returns the new selector + public key + recommended retire date.
 * Caller is responsible for any UI surfacing or audit-log entry.
 */
export async function rotateDkimKey(
  db: Database,
  emailDomainId: string,
  encryptionKey: string,
  deps: RotateDkimDeps = {},
): Promise<RotateDkimResult> {
  // emailDomains has no domain_name column — JOIN to domains.
  const [emailDomain] = await db
    .select({
      id: emailDomains.id,
      domainId: emailDomains.domainId,
      domainName: domains.domainName,
      stalwartDomainId: emailDomains.stalwartDomainId,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(eq(emailDomains.id, emailDomainId));

  if (!emailDomain) {
    throw new DkimRotationError(
      `Email domain '${emailDomainId}' not found`,
      'EMAIL_DOMAIN_NOT_FOUND',
    );
  }

  if (!emailDomain.stalwartDomainId) {
    throw new DkimRotationError(
      `Email domain '${emailDomain.domainName}' has not been provisioned to Stalwart yet`,
      'EMAIL_DOMAIN_NOT_PROVISIONED',
    );
  }

  const { privateKey, publicKey } = generateDkimKeyPairEd25519();
  const selector = newDkimSelector(deps.nowMs);
  const signatureId = `dkim-${selector}`;

  // 1. Create the DkimSignature in Stalwart
  await postDkimCreatePlan(
    deps.kubeconfigPath,
    signatureId,
    emailDomain.stalwartDomainId,
    selector,
    privateKey,
  );

  // 2. Publish the new TXT record (in-DB + push to DNS provider).
  const txtName = `${selector}._domainkey.${emailDomain.domainName}`;
  const txtValue = formatDkimDnsValue(publicKey);

  const dnsRowId = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id: dnsRowId,
    domainId: emailDomain.domainId,
    recordType: 'TXT',
    recordName: txtName,
    recordValue: txtValue,
    ttl: 3600,
    priority: null,
  });

  await syncRecordToProviders(
    db,
    emailDomain.domainId,
    emailDomain.domainName,
    'create',
    {
      type: 'TXT',
      name: txtName,
      content: txtValue,
      ttl: 3600,
      priority: null,
    },
    encryptionKey,
  );

  // Recommended retire window: >2× typical DNS TTL (3600s) plus the
  // sender-receiver mail-queue residence time. 14 days covers
  // virtually all real-world cases.
  const retireAt = new Date((deps.nowMs ?? Date.now()) + 14 * 24 * 3600 * 1000);

  return {
    newSelector: selector,
    newPublicKey: publicKey,
    txtRecordName: txtName,
    txtRecordValue: txtValue,
    recommendedRetireOldAt: retireAt.toISOString(),
    stalwartDkimSignatureId: signatureId,
  };
}
