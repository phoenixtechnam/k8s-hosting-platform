/**
 * `secrets` component capture.
 *
 * Per BACKUP_COMPONENT_MODEL.md:
 *   components/secrets/tls.json.gz.enc — encrypted TLS Secrets payload.
 *
 * Source: every Secret of `type: kubernetes.io/tls` in the client's
 * namespace (typically `client-<id>`). The TLS keys are irreproducible
 * state — without them an SSL cert restore from cert-manager could take
 * up to LE rate-limit windows.
 *
 * Encryption format: `k1:<iv-hex>:<tag-hex>:<ciphertext-hex>`
 *
 *   - `k1:` is the Key Identifier (KID) — see ADR-032 §7. Future key
 *     rotation lands as `k2:` etc. without breaking old bundles.
 *   - AES-256-GCM, 16-byte IV, 16-byte auth tag.
 *   - Key material: process.env.OIDC_ENCRYPTION_KEY (64-char hex
 *     string = 32 bytes = AES-256). Same key the OIDC module uses;
 *     splitting into a separate key is left for ADR-032 follow-up.
 *
 * Plaintext payload (before gzip + encrypt):
 *
 *   {
 *     "schemaVersion": 1,
 *     "exportedAt": "2026-05-01T10:00:00Z",
 *     "namespace": "client-abc",
 *     "secrets": [
 *       { "name": "wordpress-tls", "type": "kubernetes.io/tls",
 *         "data": { "tls.crt": "...base64...", "tls.key": "...base64..." } },
 *       …
 *     ]
 *   }
 */

import crypto from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';

const gzipAsync = promisify(gzip);

export const SECRETS_DUMP_SCHEMA_VERSION = 1 as const;
export const SECRETS_KEY_ID = 'k1' as const;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

export interface SecretsDumpV1 {
  schemaVersion: typeof SECRETS_DUMP_SCHEMA_VERSION;
  exportedAt: string;
  namespace: string;
  secrets: Array<{
    name: string;
    type: string;
    /** All keys are base64-encoded as in the underlying Secret. */
    data: Record<string, string>;
  }>;
}

export interface SecretsComponentResult {
  readonly sizeBytes: number;
  readonly secretCount: number;
  readonly encryptionKeyId: typeof SECRETS_KEY_ID;
}

/**
 * AES-256-GCM with the standard `kN:iv:tag:ciphertext` envelope.
 * Pure function — exposed for unit tests.
 */
export function encryptSecretsPayload(plaintext: Buffer, keyHex: string): string {
  const keyBuffer = Buffer.from(keyHex, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(`OIDC_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${keyBuffer.length} bytes`);
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRETS_KEY_ID}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt the standard envelope. Used by restore code (Phase 4).
 * Exposed now so the round-trip can be tested in isolation.
 */
export function decryptSecretsPayload(envelope: string, keyHex: string): Buffer {
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new Error('secrets envelope: expected kid:iv:tag:ciphertext');
  }
  const [kid, ivHex, tagHex, ctHex] = parts;
  if (kid !== SECRETS_KEY_ID) {
    // Future: dispatch by kid for key rotation.
    throw new Error(`secrets envelope: unsupported keyId '${kid}' (this platform decrypts ${SECRETS_KEY_ID})`);
  }
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, Buffer.from(ivHex!, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex!, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex!, 'hex')), decipher.final()]);
}

interface ListSecretsResponse {
  items: Array<{
    metadata?: { name?: string };
    type?: string;
    data?: Record<string, string>;
  }>;
}

/**
 * Build the secrets manifest by listing kubernetes.io/tls Secrets in
 * the client namespace. Pure data — does not encrypt.
 *
 * Pulled out as a separate function so tests can assert on the
 * filtering behaviour without exercising the encryption + gzip layers.
 */
export async function buildSecretsDump(
  k8s: K8sClients,
  namespace: string,
): Promise<SecretsDumpV1> {
  // Duck-type the kube client so this module doesn't need to import
  // the heavy K8s types — same pattern used elsewhere in the platform.
  const core = k8s.core as unknown as {
    listNamespacedSecret: (args: { namespace: string }) => Promise<ListSecretsResponse>;
  };
  const r = await core.listNamespacedSecret({ namespace });
  const tls = (r.items ?? []).filter((s) => s.type === 'kubernetes.io/tls');
  return {
    schemaVersion: SECRETS_DUMP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    namespace,
    secrets: tls.map((s) => ({
      name: s.metadata?.name ?? '',
      type: s.type ?? 'kubernetes.io/tls',
      data: s.data ?? {},
    })),
  };
}

/**
 * Capture the `secrets` component.
 *
 * Pipeline: list Secrets → JSON → gzip → AES-256-GCM → BackupStore.
 * Encryption happens in-process; the Secret material never lands on
 * disk in plaintext.
 */
export async function captureSecretsComponent(opts: {
  readonly k8s: K8sClients;
  readonly namespace: string;
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  /** AES-256 key as a 64-char hex string. */
  readonly keyHex: string;
}): Promise<SecretsComponentResult> {
  const dump = await buildSecretsDump(opts.k8s, opts.namespace);
  const json = JSON.stringify(dump);
  const gz = await gzipAsync(Buffer.from(json, 'utf8'));
  const envelope = encryptSecretsPayload(gz, opts.keyHex);
  // The envelope is ASCII (hex + colons) — safe to write as a single
  // chunk. The on-disk artifact is a small binary blob.
  const stream = Readable.from(Buffer.from(envelope, 'utf8'));
  const ref = await opts.store.writeComponent(opts.handle, 'secrets', 'tls.json.gz.enc', stream, {
    contentType: 'application/octet-stream',
  });
  return {
    sizeBytes: ref.sizeBytes,
    secretCount: dump.secrets.length,
    encryptionKeyId: SECRETS_KEY_ID,
  };
}
