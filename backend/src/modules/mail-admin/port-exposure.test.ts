import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * port-exposure unit tests — covers the 2026-05-14 streamline change
 * where the haproxy DaemonSet lifecycle moved out of Flux into
 * platform-api. The mode-flip transition now:
 *   thisNodeOnly → allServerNodes: removeHostPorts → CREATE DS
 *   allServerNodes → thisNodeOnly: DELETE DS → addHostPorts
 *
 * Previously the DS was always present with a dummy nodeSelector and
 * we patched the selector to enable/disable. These tests assert the
 * new create/delete contract.
 */

const mockReadDs = vi.fn();
const mockCreateDs = vi.fn();
const mockDeleteDs = vi.fn();
const mockReadDeployment = vi.fn();
const mockPatchDeployment = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'AppsV1Api') {
        return {
          readNamespacedDaemonSet: mockReadDs,
          createNamespacedDaemonSet: mockCreateDs,
          deleteNamespacedDaemonSet: mockDeleteDs,
          readNamespacedDeployment: mockReadDeployment,
          patchNamespacedDeployment: mockPatchDeployment,
        };
      }
      return {};
    }
  },
  AppsV1Api: { name: 'AppsV1Api' },
}));

vi.mock('../../shared/k8s-patch.js', () => ({
  applyPatch: vi.fn((_fieldManager: string, _opts: { force?: boolean }) => ({
    headers: { 'Content-Type': 'application/apply-patch+yaml' },
  })),
}));

// Minimal Database stub — drizzle queries are mocked away.
function buildDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ v: null }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  } as unknown as import('../../db/index.js').Database;
}

function notFoundError() {
  return Object.assign(new Error('not found'), { code: 404 });
}

describe('mail-admin/port-exposure.updateMailPortExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default Deployment shape for hostPort patching.
    // Combined spec (for patch path) + status (for rollout-wait path)
    // so readNamespacedDeployment returns a "rollout already complete"
    // shape on first poll — no test needs to advance time to pass.
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 5 },
      spec: {
        replicas: 1,
        template: { spec: { containers: [{ name: 'stalwart', ports: [
          { containerPort: 25, hostPort: 25, name: 'smtp', protocol: 'TCP' },
          { containerPort: 8080, name: 'mgmt-http', protocol: 'TCP' },
        ] }] } },
      },
      status: {
        observedGeneration: 5,
        updatedReplicas: 1,
        readyReplicas: 1,
        unavailableReplicas: 0,
      },
    });
    mockPatchDeployment.mockResolvedValue({});
  });

  it('thisNodeOnly → allServerNodes: removes hostPorts then CREATES the haproxy DS', async () => {
    mockReadDs.mockRejectedValue(notFoundError()); // DS absent at start
    mockCreateDs.mockResolvedValue({});
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateDs).toHaveBeenCalledTimes(1);
    expect(mockDeleteDs).not.toHaveBeenCalled();
    // The create body must be the buildHaproxyDaemonSet() shape.
    const createArg = mockCreateDs.mock.calls[0][0] as { body: { kind: string; metadata: { name: string } } };
    expect(createArg.body.kind).toBe('DaemonSet');
    expect(createArg.body.metadata.name).toBe('stalwart-haproxy');
  });

  it('thisNodeOnly → allServerNodes: does NOT re-create when DS already exists', async () => {
    mockReadDs.mockResolvedValue({ metadata: { name: 'stalwart-haproxy' } });
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockDeleteDs).not.toHaveBeenCalled();
  });

  it('allServerNodes → thisNodeOnly: DELETES the haproxy DS then re-adds hostPorts', async () => {
    mockDeleteDs.mockResolvedValue({});
    // After delete, waitForHaproxyDaemonSetGone polls readNamespacedDaemonSet
    // until it 404s. Simulate "gone immediately" so the test doesn't wait.
    mockReadDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'thisNodeOnly' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockDeleteDs).toHaveBeenCalledTimes(1);
    // Foreground propagation: confirm the delete call carried it.
    const deleteArg = mockDeleteDs.mock.calls[0][0] as { propagationPolicy?: string };
    expect(deleteArg.propagationPolicy).toBe('Foreground');
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('waits for the Deployment rollout to complete before creating the haproxy DS', async () => {
    // Streamline E2E found race: patchNamespacedDeployment returns
    // before the old pod (still binding hostPorts) is gone. If the
    // haproxy DS gets created in that window, it conflicts with
    // Stalwart's hostPort on the Stalwart-pod node. Fix:
    // replaceStalwartContainerPorts now blocks on rollout completion.
    //
    // This test simulates a 3-iteration rollout: first two polls
    // show updatedReplicas < replicas / unavailableReplicas > 0,
    // third poll shows healthy. The CREATE call must come AFTER all
    // three rollout polls.
    const callOrder: string[] = [];
    mockReadDeployment.mockReset();
    let pollCount = 0;
    mockReadDeployment.mockImplementation(async () => {
      // First call is the spec read (in replaceStalwartContainerPorts);
      // subsequent calls are the rollout-status polls.
      callOrder.push('read');
      pollCount++;
      if (pollCount === 1) {
        // spec read for hostPort patching — full shape needed
        return {
          metadata: { generation: 5 },
          spec: {
            replicas: 1,
            template: { spec: { containers: [{ name: 'stalwart', ports: [
              { containerPort: 25, hostPort: 25, name: 'smtp', protocol: 'TCP' },
            ] }] } },
          },
          status: {},
        };
      }
      if (pollCount === 2 || pollCount === 3) {
        // rollout in progress
        return {
          metadata: { generation: 6 },
          spec: { replicas: 1 },
          status: {
            observedGeneration: 6,
            updatedReplicas: 0,
            readyReplicas: 0,
            unavailableReplicas: 1,
          },
        };
      }
      // rollout complete
      return {
        metadata: { generation: 6 },
        spec: { replicas: 1 },
        status: {
          observedGeneration: 6,
          updatedReplicas: 1,
          readyReplicas: 1,
          unavailableReplicas: 0,
        },
      };
    });
    mockPatchDeployment.mockImplementation(async () => { callOrder.push('patch'); return {}; });
    mockReadDs.mockRejectedValue(notFoundError());
    mockCreateDs.mockImplementation(async () => { callOrder.push('create-ds'); return {}; });

    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    // Read happens before patch; patch happens before create-ds.
    // Critically: the rollout polling (additional reads) happens
    // BETWEEN patch and create-ds.
    expect(callOrder[0]).toBe('read');           // initial spec read
    expect(callOrder[1]).toBe('patch');          // hostPort patch
    expect(callOrder[2]).toBe('read');           // rollout poll 1 (still rolling)
    expect(callOrder[3]).toBe('read');           // rollout poll 2 (still rolling)
    expect(callOrder[4]).toBe('read');           // rollout poll 3 (complete)
    expect(callOrder[callOrder.length - 1]).toBe('create-ds');
  }, 30_000);

  it('refuses to flip when Deployment.spec.replicas == 0 (avoid false-positive rollout complete during concurrent ops)', async () => {
    mockReadDeployment.mockReset();
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 7 },
      spec: {
        replicas: 0,
        template: { spec: { containers: [{ name: 'stalwart', ports: [
          { containerPort: 25, hostPort: 25, name: 'smtp', protocol: 'TCP' },
        ] }] } },
      },
      status: { observedGeneration: 7, updatedReplicas: 0, readyReplicas: 0, unavailableReplicas: 0 },
    });
    mockReadDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    )).rejects.toMatchObject({
      code: 'MAIL_DEPLOYMENT_SCALED_TO_ZERO',
      status: 409,
    });
    // Crucially: the haproxy DS is NOT created because the rollout-wait
    // threw before the create-DS step.
    expect(mockCreateDs).not.toHaveBeenCalled();
  }, 30_000);

  it('allServerNodes → thisNodeOnly: tolerates DS already absent (404 → idempotent)', async () => {
    mockDeleteDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(updateMailPortExposure(
      { mode: 'thisNodeOnly' },
      buildDb(),
      { kubeconfigPath: undefined },
    )).resolves.not.toThrow();
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
  });
});

describe('mail-admin/port-exposure.getMailPortExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports daemonSetStatus when DS is present', async () => {
    mockReadDs.mockResolvedValue({
      status: { numberReady: 3, desiredNumberScheduled: 3 },
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ v: 'allServerNodes' }]),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { getMailPortExposure } = await import('./port-exposure.js');
    const r = await getMailPortExposure(db, { kubeconfigPath: undefined });
    expect(r.mode).toBe('allServerNodes');
    expect(r.proxyProtocolActive).toBe(true);
    expect(r.daemonSetStatus).toEqual({ ready: 3, desired: 3 });
  });

  it('reports daemonSetStatus=null when DS is absent (thisNodeOnly mode)', async () => {
    mockReadDs.mockRejectedValue(notFoundError());
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ v: 'thisNodeOnly' }]),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { getMailPortExposure } = await import('./port-exposure.js');
    const r = await getMailPortExposure(db, { kubeconfigPath: undefined });
    expect(r.mode).toBe('thisNodeOnly');
    expect(r.proxyProtocolActive).toBe(false);
    expect(r.daemonSetStatus).toBeNull();
  });
});
