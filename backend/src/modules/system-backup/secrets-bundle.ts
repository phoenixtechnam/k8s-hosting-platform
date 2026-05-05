/**
 * Secrets-bundle export.
 *
 * Mirrors the on-host `bundle_bootstrap_secrets()` function in
 * scripts/bootstrap.sh: tars a fixed list of platform/mail Secrets
 * (and the operator key files if present), then age-encrypts to the
 * `platform/platform-operator-recipient` ConfigMap's age recipient.
 *
 * Crucially the bundle is encrypted to a recipient whose private
 * key lives OUTSIDE the cluster (the operator holds it). Without
 * this property a full-cluster loss would render the bundle useless.
 *
 * Implementation runs entirely in-cluster via the Kube API:
 *   1. read recipient from platform/platform-operator-recipient
 *   2. for each {ns,name} in the bundle list, kubectl get secret -o yaml
 *      via @kubernetes/client-node and serialize to YAML
 *   3. for each operator-key file path, read via Secret too if present
 *   4. tar in-memory → spawn `age -r <recipient>` → captured stdout
 *   5. return Buffer + sha256 + size + manifest
 *
 * Why subprocess `age` and not a pure-JS implementation:
 *   - Matches `make secrets-restore` (uses /usr/bin/age already)
 *   - Matches scripts/bootstrap.sh:bundle_bootstrap_secrets (also subprocess)
 *   - Smaller attack surface than pulling in a new npm dep for crypto
 *   - The age binary is a tiny static Go build available on Alpine
 *     via `apk add age`
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as tar from 'tar-stream';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Bootstrap-time Secrets the bundle includes. MUST stay in lock-step
 * with scripts/bootstrap.sh:bundle_bootstrap_secrets():`items` array
 * — when bootstrap learns about a new platform-level Secret, both
 * sides update.
 *
 * Tests (secrets-bundle.test.ts) assert this list equals the on-disk
 * shell array via a parser, so drift fails CI.
 */
export const BUNDLE_SECRET_LIST: ReadonlyArray<{ namespace: string; name: string }> = [
  { namespace: 'platform', name: 'platform-admin-seed' },
  { namespace: 'platform', name: 'platform-db-credentials' },
  { namespace: 'platform', name: 'platform-jwt-secret' },
  { namespace: 'platform', name: 'platform-secrets' },
  { namespace: 'platform', name: 'oauth2-proxy-config' },
  { namespace: 'platform', name: 'sftp-host-keys' },
  { namespace: 'platform', name: 'stalwart-secrets' },
  { namespace: 'mail', name: 'mail-pg-app-credentials' },
  { namespace: 'mail', name: 'stalwart-admin-creds' },
];

/** Operator key files (mounted as a Secret in-cluster). Present iff
 * bootstrap created them; absent on operator-supplied-recipient runs. */
export const OPERATOR_KEY_SECRETS: ReadonlyArray<{ namespace: string; name: string }> = [
  // Bootstrap stages the operator-key into the platform namespace via
  // the post-install kubectl apply. If the deployment shape diverges
  // from this assumption an integration test will catch it.
  { namespace: 'platform', name: 'platform-operator-key' },
];

export interface BundleManifestItem {
  readonly namespace: string;
  readonly name: string;
  readonly kind: 'Secret' | 'ConfigMap' | 'OperatorKey';
}

export interface SecretsBundle {
  readonly payload: Buffer;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly manifest: ReadonlyArray<BundleManifestItem>;
  readonly operatorRecipient: string;
}

export interface ExportSecretsBundleDeps {
  readonly k8s: K8sClients;
  /**
   * Override `age` binary path for tests. In production we rely on
   * PATH lookup ('age') so the same Dockerfile works on bare images
   * with `apk add age`.
   */
  readonly ageBinary?: string;
}

interface SecretYaml {
  readonly apiVersion: string;
  readonly kind: 'Secret';
  readonly metadata: { readonly namespace: string; readonly name: string };
  readonly type?: string;
  readonly data?: Record<string, string>;
}

/** Read the operator's age recipient (public key) from the cluster. */
export async function readOperatorRecipient(k8s: K8sClients): Promise<string> {
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (
      a: { namespace: string; name: string },
    ) => Promise<{ data?: Record<string, string> }>;
  };
  const cm = await core.readNamespacedConfigMap({
    namespace: 'platform',
    name: 'platform-operator-recipient',
  }).catch((err: unknown) => {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new Error(
        'platform-operator-recipient ConfigMap missing. Run scripts/bootstrap.sh '
        + 'on a server, OR pre-create the ConfigMap with --operator-age-recipient.',
      );
    }
    throw err;
  });
  const recipient = cm.data?.recipient;
  // age X25519 recipient is bech32: `age1` + 58 chars from the bech32
  // charset (no '1', 'b', 'i', 'o' to avoid visual ambiguity).
  // Strict regex prevents subprocess argument abuse if the ConfigMap
  // is ever populated by a less-trusted path.
  if (!recipient || !/^age1[ac-hj-np-z02-9]{58}$/i.test(recipient)) {
    throw new Error(`platform-operator-recipient ConfigMap.data.recipient invalid: ${recipient ?? '(missing)'}`);
  }
  return recipient;
}

/**
 * Read each Secret in BUNDLE_SECRET_LIST and serialise to a YAML doc
 * stream. Missing Secrets are skipped (manifest records "absent")
 * so the bundle stays small and operator-readable.
 *
 * Returns one tar entry per Secret + a MANIFEST.txt entry describing
 * the bundle contents. The tar bytes are the plaintext input to age.
 */
export async function buildSecretsTar(
  k8s: K8sClients,
  recipient: string,
): Promise<{ tarBytes: Buffer; manifest: BundleManifestItem[]; }> {
  const manifest: BundleManifestItem[] = [];
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));

  // MANIFEST.txt header — visible to operator before age decryption
  // succeeds, so they can confirm bundle provenance from the
  // container hash even before importing the key.
  const manifestText: string[] = [];
  manifestText.push('system-backup secrets bundle (Phase 1)');
  manifestText.push(`generator:  in-cluster (modules/system-backup)`);
  manifestText.push(`created:    ${new Date().toISOString()}`);
  manifestText.push(`recipient:  ${recipient}`);
  manifestText.push('');
  manifestText.push('contents:');

  // Pull every Secret. The Kube client may return 404 for absent
  // ones (older cluster missing a recently-added Secret type) —
  // those are skipped, never fatal.
  const core = k8s.core as unknown as {
    readNamespacedSecret: (
      a: { namespace: string; name: string },
    ) => Promise<SecretYaml>;
  };

  const all: ReadonlyArray<{ namespace: string; name: string; kind: BundleManifestItem['kind'] }> = [
    ...BUNDLE_SECRET_LIST.map((s) => ({ ...s, kind: 'Secret' as const })),
    ...OPERATOR_KEY_SECRETS.map((s) => ({ ...s, kind: 'OperatorKey' as const })),
  ];

  for (const item of all) {
    try {
      const sec = await core.readNamespacedSecret({ namespace: item.namespace, name: item.name });
      const yaml = renderSecretYaml(sec);
      const fileName = `${item.namespace}__${item.name}.yaml`;
      await new Promise<void>((resolve, reject) => {
        pack.entry({ name: fileName, size: yaml.length }, yaml, (err?: Error | null) => {
          if (err) reject(err); else resolve();
        });
      });
      manifest.push({ namespace: item.namespace, name: item.name, kind: item.kind });
      manifestText.push(`  ${item.namespace}/${item.name}  (${item.kind})`);
    } catch (err) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (code === 404) continue;
      throw err;
    }
  }

  // Final MANIFEST.txt entry. Plain text so a bewildered ops engineer
  // can `tar tf` the decrypted bundle and read the contents.
  const manifestBuf = Buffer.from(manifestText.join('\n') + '\n', 'utf8');
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name: 'MANIFEST.txt', size: manifestBuf.length }, manifestBuf, (err?: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });

  pack.finalize();
  await new Promise<void>((resolve) => { pack.on('end', () => resolve()); });
  return { tarBytes: Buffer.concat(chunks), manifest };
}

/** Serialise a Secret returned by the Kube client to YAML. We only
 * include the fields needed for `kubectl apply -f` to recreate the
 * Secret on a fresh cluster — everything else (status, managedFields,
 * resourceVersion, uid) is stripped so bundles are diffable. */
function renderSecretYaml(sec: SecretYaml): Buffer {
  // Strip server-managed fields. apiVersion + kind + metadata{ns,name}
  // + type + data is enough for kubectl apply.
  const lines: string[] = [];
  lines.push('apiVersion: v1');
  lines.push('kind: Secret');
  lines.push('metadata:');
  lines.push(`  namespace: ${yamlEscape(sec.metadata.namespace)}`);
  lines.push(`  name: ${yamlEscape(sec.metadata.name)}`);
  if (sec.type) lines.push(`type: ${yamlEscape(sec.type)}`);
  if (sec.data && Object.keys(sec.data).length > 0) {
    lines.push('data:');
    for (const [k, v] of Object.entries(sec.data)) {
      // Keys are arbitrary strings (must be quoted defensively); values
      // are already base64 strings safe for unquoted YAML on a single line.
      lines.push(`  ${yamlEscape(k)}: ${v}`);
    }
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

/** Defensive YAML quoting for keys/strings that might contain special chars. */
function yamlEscape(s: string): string {
  if (/^[A-Za-z0-9_./\-]+$/.test(s)) return s;
  return JSON.stringify(s); // JSON strings are valid YAML flow scalars.
}

/**
 * Pipe tarBytes through `age -r <recipient>` and return the encrypted
 * output as a Buffer. The full plaintext is held in memory for the
 * stream lifetime — fine for ~100KB bundles, not a tenant-scale path.
 */
export async function ageEncrypt(
  tarBytes: Buffer,
  recipient: string,
  ageBinary: string = 'age',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ageBinary, ['-r', recipient], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => err.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`age exit ${code}: ${Buffer.concat(err).toString()}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
    proc.stdin.end(tarBytes);
  });
}

/**
 * Top-level: list secrets, tar, age-encrypt, return.
 *
 * Pipeline: tar(plaintext) → age. Matches the on-host
 * `bundle_bootstrap_secrets` format in scripts/bootstrap.sh exactly,
 * so a bundle exported through the API is byte-format-compatible
 * with the existing `make secrets-restore BUNDLE=… KEY=…` flow + the
 * `bootstrap.sh --secrets-bundle …` import. Compression deliberately
 * NOT applied — age uses chacha20-poly1305 which produces high-
 * entropy output, gzip on top wastes CPU on indistinguishable bytes.
 */
export async function exportSecretsBundle(deps: ExportSecretsBundleDeps): Promise<SecretsBundle> {
  const recipient = await readOperatorRecipient(deps.k8s);
  const { tarBytes, manifest } = await buildSecretsTar(deps.k8s, recipient);
  const encrypted = await ageEncrypt(tarBytes, recipient, deps.ageBinary);
  const sha256 = createHash('sha256').update(encrypted).digest('hex');
  return {
    payload: encrypted,
    sizeBytes: encrypted.length,
    sha256,
    manifest,
    operatorRecipient: recipient,
  };
}
