import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileBackupTarget, clearBackupTarget } from './longhorn-reconciler.js';

function createMockClients() {
  const core = {
    replaceNamespacedSecret: vi.fn(),
    createNamespacedSecret: vi.fn(),
  };
  const custom = {
    patchClusterCustomObject: vi.fn(),
    patchNamespacedCustomObject: vi.fn(),
  };
  const batch = {
    // Default: succeed silently. Tests that care about cron toggle
    // assert against this mock directly.
    patchNamespacedCronJob: vi.fn().mockResolvedValue({}),
  };
  return { core, custom, batch } as unknown as {
    core: {
      replaceNamespacedSecret: ReturnType<typeof vi.fn>;
      createNamespacedSecret: ReturnType<typeof vi.fn>;
    };
    custom: {
      patchClusterCustomObject: ReturnType<typeof vi.fn>;
      patchNamespacedCustomObject: ReturnType<typeof vi.fn>;
    };
    batch: {
      patchNamespacedCronJob: ReturnType<typeof vi.fn>;
    };
  };
}

const INPUT = {
  kind: 's3' as const,
  endpoint: 'https://fsn1.example.com',
  region: 'eu-central',
  bucket: 'k8s-staging',
  accessKeyId: 'AKIA' + 'X'.repeat(16),
  secretAccessKey: 'S'.repeat(40),
};

const SSH_INPUT = {
  kind: 'ssh' as const,
  host: 'backup.example.com',
  port: 22,
  user: 'platformbackup',
  path: '/srv/backups/staging',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAA...\n-----END OPENSSH PRIVATE KEY-----\n',
};

describe('reconcileBackupTarget', () => {
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    clients = createMockClients();
  });

  it('replaces the credentials Secret on happy path', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    // Called twice — once for longhorn-system, once for platform ns
    expect(clients.core.replaceNamespacedSecret).toHaveBeenCalledTimes(2);
    const [args] = clients.core.replaceNamespacedSecret.mock.calls[0];
    expect(args.name).toBe('longhorn-backup-credentials');
    expect(args.namespace).toBe('longhorn-system');
    expect(args.body.stringData.AWS_ACCESS_KEY_ID).toBe(INPUT.accessKeyId);
    expect(args.body.stringData.AWS_SECRET_ACCESS_KEY).toBe(INPUT.secretAccessKey);
    expect(args.body.stringData.AWS_ENDPOINTS).toBe(INPUT.endpoint);
    expect(args.body.stringData.S3_BUCKET).toBe(INPUT.bucket);
    expect(args.body.metadata.labels['app.kubernetes.io/managed-by']).toBe('platform-api');
  });

  it('marks the platform-ns Secret with TARGET_KIND=s3 on S3 activate', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    const [, platformArgs] = clients.core.replaceNamespacedSecret.mock.calls;
    expect(platformArgs[0].body.stringData.TARGET_KIND).toBe('s3');
    // Switching back from SSH→S3 must drop stale SSH keys. stringData set
    // to '' lets replaceNamespacedSecret overwrite them without leaving
    // ghost values from a prior SSH activation.
    expect(platformArgs[0].body.stringData.SSH_HOST).toBe('');
    expect(platformArgs[0].body.stringData.SSH_PRIVATE_KEY).toBe('');
  });

  it('also writes backup-credentials Secret into the platform namespace for DR CronJobs', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    const calls = clients.core.replaceNamespacedSecret.mock.calls;
    expect(calls).toHaveLength(2);
    const [, platformArgs] = calls;
    expect(platformArgs[0].name).toBe('backup-credentials');
    expect(platformArgs[0].namespace).toBe('platform');
    // Same creds + convenience keys for aws-cli (bucket/region/prefix)
    expect(platformArgs[0].body.stringData.AWS_ACCESS_KEY_ID).toBe(INPUT.accessKeyId);
    expect(platformArgs[0].body.stringData.S3_BUCKET).toBe(INPUT.bucket);
    expect(platformArgs[0].body.stringData.S3_REGION).toBe(INPUT.region);
  });

  it('continues successfully when the platform-ns sync fails (best-effort)', async () => {
    // Longhorn-ns call succeeds, BackupTarget patch succeeds, but
    // platform-ns call fails. The reconciler should log + return, not
    // throw, so the operator sees the Longhorn target go live.
    clients.core.replaceNamespacedSecret
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ statusCode: 500, message: 'platform ns down' });
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(clients as any, INPUT)).resolves.toBeUndefined();
    expect(clients.custom.patchClusterCustomObject).toHaveBeenCalled();
  });

  it('falls back to create when the Secret does not yet exist (both namespaces)', async () => {
    clients.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 404 });
    clients.core.createNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    // Called twice total — once for longhorn-system, once for platform
    expect(clients.core.replaceNamespacedSecret).toHaveBeenCalledTimes(2);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledTimes(2);
    const calls = clients.core.createNamespacedSecret.mock.calls;
    expect(calls[0][0].namespace).toBe('longhorn-system');
    expect(calls[0][0].body.metadata.name).toBe('longhorn-backup-credentials');
    expect(calls[1][0].namespace).toBe('platform');
    expect(calls[1][0].body.metadata.name).toBe('backup-credentials');
  });

  it('patches BackupTarget/default with correct S3 URL', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    expect(clients.custom.patchClusterCustomObject).toHaveBeenCalledOnce();
    const [args] = clients.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.group).toBe('longhorn.io');
    expect(args.version).toBe('v1beta2');
    expect(args.plural).toBe('backuptargets');
    expect(args.name).toBe('default');
    expect(args.body.spec.backupTargetURL).toBe('s3://k8s-staging@eu-central/');
    expect(args.body.spec.credentialSecret).toBe('longhorn-backup-credentials');
  });

  it('includes the path prefix when one is supplied', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, { ...INPUT, pathPrefix: 'longhorn-staging' });

    const [args] = clients.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.body.spec.backupTargetURL).toBe('s3://k8s-staging@eu-central/longhorn-staging');
  });

  it('strips leading/trailing slashes from the path prefix', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, { ...INPUT, pathPrefix: '//nested/path/' });

    const [args] = clients.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.body.spec.backupTargetURL).toBe('s3://k8s-staging@eu-central/nested/path');
  });

  it('falls back to namespaced BackupTarget on cluster-scope 404', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockRejectedValue({ statusCode: 404 });
    clients.custom.patchNamespacedCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    expect(clients.custom.patchClusterCustomObject).toHaveBeenCalledOnce();
    expect(clients.custom.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const [args] = clients.custom.patchNamespacedCustomObject.mock.calls[0];
    expect(args.namespace).toBe('longhorn-system');
    expect(args.name).toBe('default');
  });

  it('propagates non-404 errors from the Secret API', async () => {
    clients.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 500, message: 'boom' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(clients as any, INPUT)).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('recognises @kubernetes/client-node v1 wrapped 404 (message + string body)', async () => {
    // Exact shape observed in staging logs 2026-04-22:
    //   HTTP-Code: 404 Message: Unknown API Status Code!
    //   Body: "{\"kind\":\"Status\",\"code\":404,\"reason\":\"NotFound\",...}"
    // None of the outer properties (statusCode/code) are set — signal
    // lives only in message + JSON-stringified body.
    const wrappedErr = new Error(
      'HTTP-Code: 404 Message: Unknown API Status Code! Body: "{\\"kind\\":\\"Status\\",\\"code\\":404,\\"reason\\":\\"NotFound\\"}" Headers: {}',
    );
    clients.core.replaceNamespacedSecret.mockRejectedValueOnce(wrappedErr);
    clients.core.createNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(clients as any, INPUT)).resolves.toBeUndefined();
    // Fallback create was reached
    expect(clients.core.createNamespacedSecret).toHaveBeenCalled();
  });

  it('recognises v1 404 when body is a parseable JSON string carrying reason=NotFound', async () => {
    const err = {
      body: '{"kind":"Status","status":"Failure","code":404,"reason":"NotFound"}',
      message: 'Request failed',
    };
    clients.core.replaceNamespacedSecret.mockRejectedValueOnce(err);
    clients.core.createNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(clients as any, INPUT)).resolves.toBeUndefined();
    expect(clients.core.createNamespacedSecret).toHaveBeenCalled();
  });
});

describe('reconcileBackupTarget — SSH variant', () => {
  let clients: ReturnType<typeof createMockClients>;
  beforeEach(() => { clients = createMockClients(); });

  it('writes SSH_* keys + TARGET_KIND=ssh to the platform-ns Secret only', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, SSH_INPUT);

    // Exactly one Secret call — the platform-ns one. Longhorn-system is
    // never touched for SSH because Longhorn's BackupTarget only talks S3.
    expect(clients.core.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
    const [args] = clients.core.replaceNamespacedSecret.mock.calls[0];
    expect(args.name).toBe('backup-credentials');
    expect(args.namespace).toBe('platform');
    expect(args.body.stringData.TARGET_KIND).toBe('ssh');
    expect(args.body.stringData.SSH_HOST).toBe(SSH_INPUT.host);
    expect(args.body.stringData.SSH_PORT).toBe(String(SSH_INPUT.port));
    expect(args.body.stringData.SSH_USER).toBe(SSH_INPUT.user);
    expect(args.body.stringData.SSH_PATH).toBe(SSH_INPUT.path);
    expect(args.body.stringData.SSH_PRIVATE_KEY).toBe(SSH_INPUT.privateKey);
  });

  it('clears stale AWS_* keys when activating SSH after a prior S3 config', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, SSH_INPUT);

    const [args] = clients.core.replaceNamespacedSecret.mock.calls[0];
    // Empty-string stringData overwrites prior AWS_* on replace — keeps
    // the Secret shape deterministic across target-kind switches.
    expect(args.body.stringData.AWS_ACCESS_KEY_ID).toBe('');
    expect(args.body.stringData.AWS_SECRET_ACCESS_KEY).toBe('');
    expect(args.body.stringData.AWS_ENDPOINTS).toBe('');
    expect(args.body.stringData.S3_BUCKET).toBe('');
    expect(args.body.stringData.S3_REGION).toBe('');
  });

  it('does NOT patch the Longhorn BackupTarget CR on SSH activate', async () => {
    clients.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, SSH_INPUT);

    // Longhorn does not support SSH as a BackupTarget backend — the CR
    // is left untouched. Longhorn-level volume backups are disabled when
    // the admin panel's active config is SSH-only.
    expect(clients.custom.patchClusterCustomObject).not.toHaveBeenCalled();
    expect(clients.custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('falls back to createNamespacedSecret on 404 for SSH variant', async () => {
    clients.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 404 });
    clients.core.createNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, SSH_INPUT);

    expect(clients.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const [args] = clients.core.createNamespacedSecret.mock.calls[0];
    expect(args.namespace).toBe('platform');
    expect(args.body.metadata.name).toBe('backup-credentials');
    expect(args.body.stringData.TARGET_KIND).toBe('ssh');
  });

  it('propagates non-404 errors from the SSH Secret write', async () => {
    clients.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 500, message: 'boom' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(clients as any, SSH_INPUT)).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

describe('clearBackupTarget', () => {
  it('empties the URL and secret reference', async () => {
    const clients = createMockClients();
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(clients as any);

    const [args] = clients.custom.patchClusterCustomObject.mock.calls[0];
    expect(args.body.spec.backupTargetURL).toBe('');
    expect(args.body.spec.credentialSecret).toBe('');
  });

  it('skips the BackupTarget CR patch when kind=ssh is supplied', async () => {
    const clients = createMockClients();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(clients as any, { kind: 'ssh' });

    // SSH was never patched-in, so clearing has nothing to clear. The
    // caller still wants a well-defined no-op instead of needing to
    // branch on kind externally.
    expect(clients.custom.patchClusterCustomObject).not.toHaveBeenCalled();
    expect(clients.custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe('DR CronJob suspend toggle', () => {
  // Names listed in BACKUP_CRONJOB_NAMES (longhorn-reconciler.ts). Kept
  // in lockstep with k8s/base/backup/*.yaml — every CronJob there that
  // mounts the backup-credentials Secret OR audits backup coverage
  // must appear here.
  const EXPECTED_CRONJOBS = [
    'platform-cluster-state-backup',
    'platform-etcd-snapshot-upload',
    'platform-pg-backup',
    'platform-secrets-backup',
    'platform-hostpath-snapshot-upload',
    'platform-backup-audit',
  ];

  it('unsuspends every DR CronJob on S3 activate', async () => {
    const clients = createMockClients();
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    expect(clients.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    const namesPatched = clients.batch.patchNamespacedCronJob.mock.calls.map((c) => c[0].name);
    expect(namesPatched).toEqual(expect.arrayContaining(EXPECTED_CRONJOBS));
    for (const call of clients.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].namespace).toBe('platform');
      expect(call[0].body).toEqual({ spec: { suspend: false } });
    }
  });

  it('unsuspends every DR CronJob on SSH activate', async () => {
    const clients = createMockClients();
    clients.core.replaceNamespacedSecret.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, SSH_INPUT);

    expect(clients.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    for (const call of clients.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].body).toEqual({ spec: { suspend: false } });
    }
  });

  it('suspends every DR CronJob on clearBackupTarget (S3)', async () => {
    const clients = createMockClients();
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(clients as any);

    expect(clients.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    for (const call of clients.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].body).toEqual({ spec: { suspend: true } });
    }
  });

  it('suspends every DR CronJob on clearBackupTarget (SSH)', async () => {
    const clients = createMockClients();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await clearBackupTarget(clients as any, { kind: 'ssh' });

    expect(clients.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
    for (const call of clients.batch.patchNamespacedCronJob.mock.calls) {
      expect(call[0].body).toEqual({ spec: { suspend: true } });
    }
  });

  it('skips toggle silently when batch client is not provided (legacy callers)', async () => {
    const clients = createMockClients();
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});
    const noBatch = { core: clients.core, custom: clients.custom };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(noBatch as any, INPUT)).resolves.toBeUndefined();
    // The reconciler still completes the Secret + BackupTarget writes;
    // only the cron toggle is skipped (the warning lands in console.warn).
    expect(clients.core.replaceNamespacedSecret).toHaveBeenCalled();
  });

  it('continues past a missing CronJob (404) on activate', async () => {
    const clients = createMockClients();
    clients.core.replaceNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});
    // Simulate first cron not deployed yet (e.g. partial Flux apply)
    clients.batch.patchNamespacedCronJob
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(reconcileBackupTarget(clients as any, INPUT)).resolves.toBeUndefined();
    // All five attempted; first 404 swallowed, remaining four succeed.
    expect(clients.batch.patchNamespacedCronJob).toHaveBeenCalledTimes(EXPECTED_CRONJOBS.length);
  });
});
