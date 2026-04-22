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
  return { core, custom } as unknown as {
    core: {
      replaceNamespacedSecret: ReturnType<typeof vi.fn>;
      createNamespacedSecret: ReturnType<typeof vi.fn>;
    };
    custom: {
      patchClusterCustomObject: ReturnType<typeof vi.fn>;
      patchNamespacedCustomObject: ReturnType<typeof vi.fn>;
    };
  };
}

const INPUT = {
  endpoint: 'https://fsn1.example.com',
  region: 'eu-central',
  bucket: 'k8s-staging',
  accessKeyId: 'AKIA' + 'X'.repeat(16),
  secretAccessKey: 'S'.repeat(40),
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

    expect(clients.core.replaceNamespacedSecret).toHaveBeenCalledOnce();
    const [args] = clients.core.replaceNamespacedSecret.mock.calls[0];
    expect(args.name).toBe('longhorn-backup-credentials');
    expect(args.namespace).toBe('longhorn-system');
    expect(args.body.stringData.AWS_ACCESS_KEY_ID).toBe(INPUT.accessKeyId);
    expect(args.body.stringData.AWS_SECRET_ACCESS_KEY).toBe(INPUT.secretAccessKey);
    expect(args.body.stringData.AWS_ENDPOINTS).toBe(INPUT.endpoint);
    expect(args.body.metadata.labels['app.kubernetes.io/managed-by']).toBe('platform-api');
  });

  it('falls back to create when the Secret does not yet exist', async () => {
    clients.core.replaceNamespacedSecret.mockRejectedValue({ statusCode: 404 });
    clients.core.createNamespacedSecret.mockResolvedValue({});
    clients.custom.patchClusterCustomObject.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileBackupTarget(clients as any, INPUT);

    expect(clients.core.replaceNamespacedSecret).toHaveBeenCalledOnce();
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledOnce();
    const [args] = clients.core.createNamespacedSecret.mock.calls[0];
    expect(args.namespace).toBe('longhorn-system');
    expect(args.body.metadata.name).toBe('longhorn-backup-credentials');
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
});
