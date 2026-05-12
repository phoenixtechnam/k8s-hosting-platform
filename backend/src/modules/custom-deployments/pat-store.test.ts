import { describe, it, expect, vi } from 'vitest';
import {
  redact,
  k8sPullSecretName,
  materializePullSecret,
  deletePullSecret,
  loadDecryptedToken,
} from './pat-store.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { encrypt, decrypt } from '../oidc/crypto.js';

// 32 random hex bytes = 64 hex chars (256-bit AES key).
const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ─── crypto envelope round-trip ────────────────────────────────────────────
//
// We don't re-test the underlying encrypt/decrypt (covered by
// oidc tests) — but we DO verify the cleartext-disappearance contract:
// a token submitted to pat-store can be recovered ONLY when the
// caller supplies the same key, and the ciphertext on disk never
// echoes the last-four chars in a way an attacker could recover.

describe('redact()', () => {
  it('keeps only the last 4 chars visible', () => {
    expect(redact('ghp_abcdef123456')).toBe('************3456');
  });
  it('masks fully when the token is <=4 chars', () => {
    expect(redact('abcd')).toBe('****');
    expect(redact('a')).toBe('*');
  });
  it('handles empty string', () => {
    expect(redact('')).toBe('');
  });
});

describe('crypto round-trip via oidc/crypto', () => {
  it('encrypt → decrypt yields the original token', () => {
    const t = 'ghp_aBcDeF_0123456789';
    const c = encrypt(t, TEST_KEY);
    expect(c).not.toContain(t); // ciphertext does not embed cleartext
    expect(decrypt(c, TEST_KEY)).toBe(t);
  });
  it('decrypt with a different key throws', () => {
    const c = encrypt('secret', TEST_KEY);
    const wrong = 'f'.repeat(64);
    expect(() => decrypt(c, wrong)).toThrow();
  });
  it('ciphertext is non-deterministic (random IV)', () => {
    const a = encrypt('same', TEST_KEY);
    const b = encrypt('same', TEST_KEY);
    expect(a).not.toBe(b);
  });
});

describe('k8sPullSecretName', () => {
  it('renders the deterministic name', () => {
    expect(k8sPullSecretName('dep-123')).toBe('image-pull-dep-123');
  });
});

// ─── k8s Secret materialisation ─────────────────────────────────────────────

function mockK8s(): K8sClients {
  return {
    core: {
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
      patchNamespacedSecret: vi.fn().mockResolvedValue({}),
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['core'],
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
  };
}

describe('materializePullSecret', () => {
  it('creates a kubernetes.io/dockerconfigjson Secret', async () => {
    const k8s = mockK8s();
    await materializePullSecret(k8s, 'tenant-ns', 'dep-1', {
      registryHost: 'ghcr.io',
      username: 'sb',
      token: 'ghp_secret',
    });
    expect(k8s.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const call = (k8s.core.createNamespacedSecret as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      namespace: string;
      body: { metadata: { name: string }; type: string; data: Record<string, string> };
    };
    expect(call.namespace).toBe('tenant-ns');
    expect(call.body.metadata.name).toBe('image-pull-dep-1');
    expect(call.body.type).toBe('kubernetes.io/dockerconfigjson');
    expect(call.body.data['.dockerconfigjson']).toBeDefined();
  });

  it('embeds the username:token in base64 auth field', async () => {
    const k8s = mockK8s();
    await materializePullSecret(k8s, 'ns', 'dep-1', {
      registryHost: 'ghcr.io',
      username: 'sb',
      token: 'ghp_secret',
    });
    const call = (k8s.core.createNamespacedSecret as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      body: { data: { '.dockerconfigjson': string } };
    };
    const decoded = JSON.parse(
      Buffer.from(call.body.data['.dockerconfigjson'], 'base64').toString('utf8'),
    ) as { auths: Record<string, { username: string; password: string; auth: string }> };
    expect(decoded.auths['ghcr.io'].username).toBe('sb');
    expect(decoded.auths['ghcr.io'].password).toBe('ghp_secret');
    const decodedAuth = Buffer.from(decoded.auths['ghcr.io'].auth, 'base64').toString('utf8');
    expect(decodedAuth).toBe('sb:ghp_secret');
  });

  it('patches an existing Secret on 409 conflict (rotation path)', async () => {
    const k8s = mockK8s();
    (k8s.core.createNamespacedSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('HTTP-Code: 409 already exists'), { statusCode: 409 }),
    );
    await materializePullSecret(k8s, 'ns', 'dep-1', {
      registryHost: 'ghcr.io',
      username: 'sb',
      token: 'ghp_rotated',
    });
    expect(k8s.core.patchNamespacedSecret).toHaveBeenCalledTimes(1);
    const patchCall = (k8s.core.patchNamespacedSecret as ReturnType<typeof vi.fn>).mock.calls[0];
    const override = patchCall[1] as { _expectedContentType?: string };
    expect(override?._expectedContentType).toBe('application/strategic-merge-patch+json');
  });

  it('wraps unexpected k8s errors without echoing the request body', async () => {
    const k8s = mockK8s();
    (k8s.core.createNamespacedSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('HTTP-Code: 500 forwarding ".dockerconfigjson":"BASE64SECRET=="'), { statusCode: 500 }),
    );
    let thrown: unknown;
    try {
      await materializePullSecret(k8s, 'ns', 'dep-1', {
        registryHost: 'ghcr.io',
        username: 'sb',
        token: 'ghp_leak_me',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const msg = (thrown as Error).message;
    expect(msg).not.toContain('BASE64SECRET');
    expect(msg).not.toContain('ghp_leak_me');
  });
});

describe('loadDecryptedToken', () => {
  // Helper: build a stub DB that returns whatever row we hand it
  // from `select().from(customDeploymentImageCredentials).where(...)`.
  function dbWithRow(row: { tokenCipher: string; registryHost: string; username: string } | null): Database {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => (row ? [row] : [])),
        })),
      })),
    } as unknown as Database;
  }

  it('returns null when no credential row exists', async () => {
    const r = await loadDecryptedToken(dbWithRow(null), 'dep-1', TEST_KEY);
    expect(r).toBe(null);
  });

  it('round-trips a stored token', async () => {
    const original = 'ghp_round_trip';
    const tokenCipher = encrypt(original, TEST_KEY);
    const r = await loadDecryptedToken(
      dbWithRow({ tokenCipher, registryHost: 'ghcr.io', username: 'sb' }),
      'dep-1',
      TEST_KEY,
    );
    expect(r).not.toBeNull();
    expect(r!.token).toBe(original);
    expect(r!.username).toBe('sb');
    expect(r!.registryHost).toBe('ghcr.io');
  });

  it('throws PAT_DECRYPT_FAILED on wrong key — without echoing ciphertext', async () => {
    const tokenCipher = encrypt('secret', TEST_KEY);
    const wrongKey = 'f'.repeat(64);
    let thrown: unknown;
    try {
      await loadDecryptedToken(
        dbWithRow({ tokenCipher, registryHost: 'ghcr.io', username: 'sb' }),
        'dep-1',
        wrongKey,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const msg = (thrown as Error).message;
    expect(msg).toContain('re-submitted');
    // The error message MUST NOT echo the ciphertext (which has been
    // observed to land in node-crypto error messages on some
    // builds).
    expect(msg).not.toContain(tokenCipher);
  });
});

describe('deletePullSecret', () => {
  it('treats 404 as success (idempotent)', async () => {
    const k8s = mockK8s();
    (k8s.core.deleteNamespacedSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('HTTP-Code: 404 not found'), { statusCode: 404 }),
    );
    await expect(deletePullSecret(k8s, 'ns', 'dep-1')).resolves.toBeUndefined();
  });
  it('rethrows non-404 errors', async () => {
    const k8s = mockK8s();
    (k8s.core.deleteNamespacedSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('HTTP-Code: 500'), { statusCode: 500 }),
    );
    await expect(deletePullSecret(k8s, 'ns', 'dep-1')).rejects.toThrow();
  });
  it('uses the deterministic Secret name', async () => {
    const k8s = mockK8s();
    await deletePullSecret(k8s, 'ns', 'dep-1');
    expect(k8s.core.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'image-pull-dep-1',
      namespace: 'ns',
    });
  });
});
