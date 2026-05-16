import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileRoundcubeDb } from './reconciler.js';

// Stub k8s.Exec so the test never opens a WebSocket. The class's
// `exec` method is the only thing the reconciler calls — we replace
// it with a vi.fn() that mimics a successful run by invoking the
// completion callback synchronously after the next tick.
const mockExecImpl = vi.fn();
vi.mock('@kubernetes/client-node', async () => {
  const actual = await vi.importActual<typeof import('@kubernetes/client-node')>('@kubernetes/client-node');
  // Need a real constructor so `new k8s.Exec(kc)` works. vi.fn() can
  // be `new`-called; we override the prototype to expose `exec`.
  function Exec(this: { exec: typeof mockExecImpl }) {
    this.exec = mockExecImpl;
  }
  return {
    ...actual,
    Exec: Exec as unknown as typeof actual.Exec,
  };
});

function makeCore(opts: {
  secretPassword?: string | null;
  secretMissing?: boolean;
  primaryPodName?: string | null;
}) {
  const readNamespacedSecret = vi.fn(({ name }: { name: string }) => {
    if (name !== 'roundcube-secrets') {
      return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
    }
    if (opts.secretMissing) {
      return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
    }
    if (opts.secretPassword === undefined || opts.secretPassword === null) {
      return Promise.resolve({ data: {} });
    }
    return Promise.resolve({
      data: { ROUNDCUBEMAIL_DB_PASSWORD: Buffer.from(opts.secretPassword).toString('base64') },
    });
  });
  const listNamespacedPod = vi.fn(() => {
    if (opts.primaryPodName === null) return Promise.resolve({ items: [] });
    return Promise.resolve({
      items: [{ metadata: { name: opts.primaryPodName ?? 'system-db-1' } }],
    });
  });
  return { readNamespacedSecret, listNamespacedPod };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const fakeKc = {} as never;

beforeEach(() => {
  mockExecImpl.mockReset();
  // Default: exec runs cleanly via callback.
  mockExecImpl.mockImplementation((
    _ns: string,
    _pod: string,
    _ctr: string,
    _argv: string[],
    _stdout: NodeJS.WritableStream,
    _stderr: NodeJS.WritableStream,
    _stdin: NodeJS.ReadableStream,
    _tty: boolean,
    cb: (s: { status: string }) => void,
  ) => {
    setImmediate(() => cb({ status: 'Success' }));
    return Promise.resolve();
  });
});

describe('reconcileRoundcubeDb', () => {
  it('skips when the Secret is missing', async () => {
    const core = makeCore({ secretMissing: true });
    const log = makeLog();
    const result = await reconcileRoundcubeDb(core as never, fakeKc, log);
    expect(result).toEqual({
      skipped: true,
      skipReason: 'secret_missing',
      applied: false,
    });
    expect(mockExecImpl).not.toHaveBeenCalled();
  });

  it('skips when the Secret has no ROUNDCUBEMAIL_DB_PASSWORD field', async () => {
    const core = makeCore({ secretPassword: null });
    const log = makeLog();
    const result = await reconcileRoundcubeDb(core as never, fakeKc, log);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('secret_missing');
  });

  it('skips when the password is empty', async () => {
    const core = makeCore({ secretPassword: '' });
    const log = makeLog();
    const result = await reconcileRoundcubeDb(core as never, fakeKc, log);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('secret_missing');
  });

  it('skips when no CNPG primary pod is found', async () => {
    const core = makeCore({ secretPassword: 'pw', primaryPodName: null });
    const log = makeLog();
    const result = await reconcileRoundcubeDb(core as never, fakeKc, log);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('primary_pod_missing');
    expect(mockExecImpl).not.toHaveBeenCalled();
  });

  it('execs psql against the primary pod with -v rcpw=<password>', async () => {
    const core = makeCore({ secretPassword: 'super-secret-pw' });
    const log = makeLog();
    const result = await reconcileRoundcubeDb(core as never, fakeKc, log);
    expect(result).toEqual({
      skipped: false,
      applied: true,
      stderr: '',
    });
    expect(mockExecImpl).toHaveBeenCalledOnce();
    const [ns, pod, ctr, argv] = mockExecImpl.mock.calls[0] as [
      string, string, string, string[],
    ];
    expect(ns).toBe('platform');
    expect(pod).toBe('system-db-1');
    expect(ctr).toBe('postgres');
    expect(argv).toContain('psql');
    expect(argv).toContain('-X');
    // Password threaded via -v rcpw=<value>, not shell-interpolated.
    expect(argv).toContain('-v');
    const vIdx = argv.indexOf('-v');
    expect(argv[vIdx + 1]).toBe('rcpw=super-secret-pw');
  });

  it('SQL piped via stdin contains the gexec pattern (no DO block)', async () => {
    let capturedStdin = '';
    mockExecImpl.mockImplementation((
      _ns: string,
      _pod: string,
      _ctr: string,
      _argv: string[],
      _stdout: NodeJS.WritableStream,
      _stderr: NodeJS.WritableStream,
      stdin: NodeJS.ReadableStream,
      _tty: boolean,
      cb: (s: { status: string }) => void,
    ) => {
      stdin.on('data', (c: Buffer) => { capturedStdin += c.toString('utf8'); });
      stdin.on('end', () => setImmediate(() => cb({ status: 'Success' })));
      return Promise.resolve();
    });

    const core = makeCore({ secretPassword: 'pw-with-no-special-chars' });
    const log = makeLog();
    await reconcileRoundcubeDb(core as never, fakeKc, log);

    // SQL uses the \gexec trick + quote_literal — never embeds the
    // password value directly in the SQL text. The password threads
    // through psql's :'rcpw' substitution and quote_literal() at
    // runtime on the server.
    expect(capturedStdin).toContain("quote_literal(:'rcpw')");
    expect(capturedStdin).toContain('\\gexec');
    expect(capturedStdin).toContain("WHERE rolname = 'roundcube'");
    expect(capturedStdin).toContain("WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'roundcube')");
    expect(capturedStdin).toContain('GRANT ALL PRIVILEGES ON DATABASE roundcube TO roundcube');
    // The password value itself MUST NOT appear in the SQL stream —
    // it travels only via the -v CLI arg.
    expect(capturedStdin).not.toContain('pw-with-no-special-chars');
  });

  it('reports failure with stderr when psql exits non-zero', async () => {
    mockExecImpl.mockImplementation((
      _ns: string,
      _pod: string,
      _ctr: string,
      _argv: string[],
      _stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
      _stdin: NodeJS.ReadableStream,
      _tty: boolean,
      cb: (s: { status: string }) => void,
    ) => {
      stderr.write('psql: ERROR: permission denied\n');
      setImmediate(() => cb({ status: 'Failure' }));
      return Promise.resolve();
    });
    const core = makeCore({ secretPassword: 'pw' });
    const log = makeLog();
    const result = await reconcileRoundcubeDb(core as never, fakeKc, log);
    expect(result.applied).toBe(false);
    expect(result.stderr).toContain('permission denied');
    expect(log.warn).toHaveBeenCalled();
  });
});
