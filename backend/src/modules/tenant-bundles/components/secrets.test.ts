import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import {
  encryptSecretsPayload,
  decryptSecretsPayload,
  buildSecretsDump,
  captureSecretsComponent,
  SECRETS_DUMP_SCHEMA_VERSION,
  SECRETS_KEY_ID,
} from './secrets.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';

const KEY_HEX = 'a'.repeat(64);

describe('encryptSecretsPayload / decryptSecretsPayload', () => {
  it('round-trips a payload with the k1 KID prefix', () => {
    const plain = Buffer.from('hello world', 'utf8');
    const env = encryptSecretsPayload(plain, KEY_HEX);
    expect(env.startsWith(`${SECRETS_KEY_ID}:`)).toBe(true);
    const decoded = decryptSecretsPayload(env, KEY_HEX);
    expect(decoded.toString('utf8')).toBe('hello world');
  });

  it('rejects an envelope with an unknown KID', () => {
    expect(() => decryptSecretsPayload('k99:00:00:deadbeef', KEY_HEX)).toThrow();
  });

  it('rejects a short auth tag (defence-in-depth)', () => {
    // Build an otherwise-well-formed envelope with a 4-byte tag.
    const ivHex = '00'.repeat(12);
    const tagHex = '00'.repeat(4);
    expect(() => decryptSecretsPayload(`k1:${ivHex}:${tagHex}:deadbeef`, KEY_HEX))
      .toThrow(/auth tag must be 16 bytes/);
  });

  it('rejects a wrong-length IV (defence-in-depth)', () => {
    // 8-byte IV in a k1 envelope should be rejected.
    const ivHex = '00'.repeat(8);
    const tagHex = '00'.repeat(16);
    expect(() => decryptSecretsPayload(`k1:${ivHex}:${tagHex}:deadbeef`, KEY_HEX))
      .toThrow(/IV must be 12 bytes/);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptSecretsPayload(Buffer.from('x'), 'aa')).toThrow();
  });

  it('produces a different IV (and thus different ciphertext) on every call', () => {
    const plain = Buffer.from('same payload');
    const a = encryptSecretsPayload(plain, KEY_HEX);
    const b = encryptSecretsPayload(plain, KEY_HEX);
    expect(a).not.toBe(b);
  });
});

describe('buildSecretsDump', () => {
  it('filters out non-TLS Secrets', async () => {
    const fakeK8s = {
      core: {
        listNamespacedSecret: vi.fn(async () => ({
          items: [
            { metadata: { name: 'wp-tls' }, type: 'kubernetes.io/tls', data: { 'tls.crt': 'YWJj', 'tls.key': 'ZGVm' } },
            { metadata: { name: 'docker-cred' }, type: 'kubernetes.io/dockerconfigjson', data: {} },
            { metadata: { name: 'opaque-thing' }, type: 'Opaque', data: {} },
          ],
        })),
      },
    } as unknown as K8sClients;
    const dump = await buildSecretsDump(fakeK8s, 'client-abc');
    expect(dump.schemaVersion).toBe(SECRETS_DUMP_SCHEMA_VERSION);
    expect(dump.namespace).toBe('client-abc');
    expect(dump.secrets).toHaveLength(1);
    expect(dump.secrets[0]!.name).toBe('wp-tls');
  });
});

describe('captureSecretsComponent', () => {
  it('writes an encrypted, gzipped bundle via the BackupStore', async () => {
    const writes: { name: string; body: Buffer }[] = [];
    const fakeStore = {
      kind: 'hostpath',
      writeComponent: vi.fn(async (_h: BundleHandle, _component: string, name: string, body: Readable) => {
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        writes.push({ name, body: buf });
        return { component: 'secrets' as const, name, sizeBytes: buf.length };
      }),
    } as unknown as BackupStore;

    const fakeK8s = {
      core: {
        listNamespacedSecret: vi.fn(async () => ({
          items: [{ metadata: { name: 'a-tls' }, type: 'kubernetes.io/tls', data: { 'tls.crt': 'Cg==' } }],
        })),
      },
    } as unknown as K8sClients;

    const r = await captureSecretsComponent({
      k8s: fakeK8s,
      namespace: 'client-abc',
      store: fakeStore,
      handle: { bundleId: 'bk', _backend: {} },
      keyHex: KEY_HEX,
    });

    expect(r.secretCount).toBe(1);
    expect(r.encryptionKeyId).toBe('k1');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.name).toBe('tls.json.gz.enc');

    // Decrypt + decompress + verify shape.
    const envelope = writes[0]!.body.toString('utf8');
    const decompressed = gunzipSync(decryptSecretsPayload(envelope, KEY_HEX));
    const decoded = JSON.parse(decompressed.toString('utf8'));
    expect(decoded.schemaVersion).toBe(SECRETS_DUMP_SCHEMA_VERSION);
    expect(decoded.secrets).toHaveLength(1);
    expect(decoded.secrets[0].data['tls.crt']).toBe('Cg==');
  });
});
