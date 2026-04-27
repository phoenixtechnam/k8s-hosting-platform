import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @kubernetes/client-node ───────────────────────────────────────────

const mockApplyToHTTPSOptions = vi.fn().mockResolvedValue(undefined);

// Vitest 4 requires real class constructors (plain factory functions
// aren't callable with `new`). See db-manager.test.ts for the same pattern.
vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig {
    loadFromFile = vi.fn();
    loadFromCluster = vi.fn();
    getCurrentCluster = vi.fn().mockReturnValue({
      server: 'https://localhost:6443',
      name: 'default',
    });
    applyToHTTPSOptions = mockApplyToHTTPSOptions;
    getCurrentUser = vi.fn().mockReturnValue({ token: 'test-bearer-token' });
  }
  return { KubeConfig: MockKubeConfig };
});

// ─── Mock k8s-lifecycle ─────────────────────────────────────────────────────

const mockEnsureRunning = vi.fn().mockResolvedValue(undefined);
const mockGetStatus = vi.fn().mockResolvedValue({ ready: true, phase: 'running', message: 'OK' });
const mockStopFileManager = vi.fn().mockResolvedValue(undefined);

vi.mock('./k8s-lifecycle.js', () => ({
  ensureFileManagerRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  getFileManagerStatus: (...args: unknown[]) => mockGetStatus(...args),
  stopFileManager: (...args: unknown[]) => mockStopFileManager(...args),
}));

// ─── Mock node:https ────────────────────────────────────────────────────────

const mockWrite = vi.fn().mockReturnValue(true);
const mockEnd = vi.fn();
const mockRequestOn = vi.fn();

let capturedCallback: ((res: unknown) => void) | null = null;

const mockHttpsRequest = vi.fn().mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
  capturedCallback = callback;

  // Simulate async response
  setTimeout(() => {
    const mockRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        if (event === 'data') handler(Buffer.from('{"files":[]}'));
        if (event === 'end') handler();
      }),
    };
    callback(mockRes);
  }, 0);

  return {
    on: mockRequestOn,
    write: mockWrite,
    end: mockEnd,
    once: vi.fn(),
  };
});

vi.mock('node:https', () => ({
  default: {
    request: (...args: unknown[]) => mockHttpsRequest(...args),
  },
}));

// ─── Import module under test ───────────────────────────────────────────────

const { proxyToFileManager, fileManagerRequest } = await import('./service.js');

// ─── Mock K8sClients ────────────────────────────────────────────────────────

const mockK8sClients = {
  coreV1Api: {},
  appsV1Api: {},
  networkingV1Api: {},
  customObjectsApi: {},
} as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('file-manager service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus.mockResolvedValue({ ready: true, phase: 'running', message: 'OK' });
    mockEnsureRunning.mockResolvedValue(undefined);
  });

  describe('proxyToFileManager', () => {
    it('should build correct proxy path through K8s API', async () => {
      const resultPromise = proxyToFileManager(
        '/path/to/kubeconfig',
        'client-ns-1',
        '/api/files',
      );

      const result = await resultPromise;

      expect(mockHttpsRequest).toHaveBeenCalled();
      const callArgs = mockHttpsRequest.mock.calls[0][0] as { path: string; hostname: string };
      expect(callArgs.path).toContain('/api/v1/namespaces/client-ns-1/services/file-manager:8111/proxy/api/files');
      expect(callArgs.hostname).toBe('localhost');
    });

    it('should include query parameters in proxy path', async () => {
      const resultPromise = proxyToFileManager(
        '/path/to/kubeconfig',
        'client-ns-1',
        '/api/files',
        { query: { path: '/var/www' } },
      );

      const result = await resultPromise;

      const callArgs = mockHttpsRequest.mock.calls[0][0] as { path: string };
      expect(callArgs.path).toContain('path=%2Fvar%2Fwww');
    });

    it('should send body and set Content-Length header', async () => {
      const body = JSON.stringify({ content: 'hello world' });

      const resultPromise = proxyToFileManager(
        '/path/to/kubeconfig',
        'client-ns-1',
        '/api/files',
        { method: 'PUT', body, contentType: 'application/json' },
      );

      const result = await resultPromise;

      const callArgs = mockHttpsRequest.mock.calls[0][0] as { headers: Record<string, string>; method: string };
      expect(callArgs.method).toBe('PUT');
      expect(callArgs.headers['Content-Type']).toBe('application/json');
      expect(callArgs.headers['Content-Length']).toBe(String(Buffer.byteLength(body)));
    });

    it('should include bearer token from kubeconfig user', async () => {
      const resultPromise = proxyToFileManager(
        '/path/to/kubeconfig',
        'client-ns-1',
        '/api/files',
      );

      const result = await resultPromise;

      const callArgs = mockHttpsRequest.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers['Authorization']).toBe('Bearer test-bearer-token');
    });

    it('should return body as string and bodyBuffer as Buffer', async () => {
      const result = await proxyToFileManager(
        '/path/to/kubeconfig',
        'client-ns-1',
        '/api/files',
      );

      expect(typeof result.body).toBe('string');
      expect(Buffer.isBuffer(result.bodyBuffer)).toBe(true);
      expect(result.status).toBe(200);
      expect(result.headers).toHaveProperty('content-type', 'application/json');
    });
  });

  describe('fileManagerRequest', () => {
    it('should ensure FM is running before proxying', async () => {
      const result = await fileManagerRequest(
        mockK8sClients,
        '/path/to/kubeconfig',
        'client-ns-1',
        'file-manager:latest',
        '/api/files',
      );

      // Phase D fix: fileManagerRequest passes initialReplicas=1 so the
      // /files/start path scales FM up from the 0 it was provisioned
      // with (avoids RWO Multi-Attach with workload pods).
      expect(mockEnsureRunning).toHaveBeenCalledWith(mockK8sClients, 'client-ns-1', 'file-manager:latest', 1);
      expect(mockGetStatus).toHaveBeenCalled();
      expect(result.status).toBe(200);
    });

    it('should throw if FM fails to become ready', async () => {
      mockGetStatus.mockResolvedValue({ ready: false, phase: 'failed', message: 'CrashLoopBackOff' });

      await expect(
        fileManagerRequest(
          mockK8sClients,
          '/path/to/kubeconfig',
          'client-ns-1',
          'file-manager:latest',
          '/api/files',
        ),
      ).rejects.toThrow('File manager not ready');
    });

    it('should throw with timeout message if FM never becomes ready', async () => {
      // Simulate timeout: always return not ready, non-failed
      mockGetStatus.mockResolvedValue({ ready: false, phase: 'pending', message: 'Waiting' });

      await expect(
        fileManagerRequest(
          mockK8sClients,
          '/path/to/kubeconfig',
          'client-ns-1',
          'file-manager:latest',
          '/api/files',
        ),
      ).rejects.toThrow('File manager not ready');
    }, 60_000);

    it('should pass method and body options through to proxy', async () => {
      const body = '{"action":"delete"}';

      await fileManagerRequest(
        mockK8sClients,
        '/path/to/kubeconfig',
        'client-ns-1',
        'file-manager:latest',
        '/api/files',
        { method: 'DELETE', body, contentType: 'application/json' },
      );

      const callArgs = mockHttpsRequest.mock.calls[0][0] as { method: string };
      expect(callArgs.method).toBe('DELETE');
    });
  });
});
