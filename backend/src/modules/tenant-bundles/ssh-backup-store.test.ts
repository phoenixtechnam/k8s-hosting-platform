import { describe, it, expect } from 'vitest';
import { SshBackupStore } from './ssh-backup-store.js';

/*
 * SshBackupStore tests focus on the *pure* surface that doesn't need
 * a live SSH server: backupId/artifact-name validation, path
 * construction, error envelopes. Integration with a real SFTP
 * server happens in scripts/integration-staging.sh.
 */

function makeStore() {
  return new SshBackupStore({
    host: 'example.com',
    port: 22,
    user: 'backup',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----',
    basePath: '/backups/k8s-staging',
  });
}

describe('SshBackupStore — path-traversal guards', () => {
  it.each(['..', '.', '../etc', 'foo/bar', '/abs', 'name with space'])(
    'reserveBundle rejects unsafe backupId %s',
    async (backupId) => {
      const store = makeStore();
      await expect(store.reserveBundle({ backupId, clientId: 'c1' }))
        .rejects.toThrow(/invalid backupId/);
    },
  );

  it('reserveBundle accepts a normal `bkp-<uuid>` shape (will fail later on real SSH connect)', async () => {
    const store = makeStore();
    // The validator accepts the id; only the actual SSH connect fails
    // because there's no live server. We assert the failure message
    // is NOT the "invalid backupId" one — i.e. the guard let it past.
    await expect(store.reserveBundle({
      backupId: 'bkp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      clientId: 'c1',
    })).rejects.not.toThrow(/invalid backupId/);
  });
});

describe('SshBackupStore — artifact-name validation', () => {
  it.each(['..', '.', 'a/b', '/abs.txt'])(
    'writeComponent rejects unsafe name %s',
    async (name) => {
      const store = makeStore();
      // Pass a bogus handle directly — the artifactPath helper checks
      // the name BEFORE attempting SSH I/O.
      const handle = { bundleId: 'bkp-x', _backend: { bundlePath: '/backups/k8s-staging/bkp-x' } };
      const stream = (await import('node:stream')).Readable.from(Buffer.from('x'));
      await expect(store.writeComponent(handle, 'config', name, stream))
        .rejects.toThrow(/invalid artifact name|path traversal/);
    },
  );
});
