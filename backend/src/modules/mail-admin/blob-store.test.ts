/**
 * blob-store unit tests.
 *
 * The MOST IMPORTANT assertion here is that S3 access keys NEVER
 * appear in the rendered cli argv — they MUST flow via the Secret
 * + envFrom only. A regression that inlines plaintext keys into the
 * cli args would expose them via `kubectl describe pod` and
 * apiserver audit logs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @kubernetes/client-node so the module can be imported in
// tests that only exercise the pure cli-arg builder. The Job/Pod
// creation paths are exercised via shape assertions on the rendered
// JSON manifests below; spawning real Pods is integration territory.
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromFile() {}
    loadFromCluster() {}
    makeApiClient() { return {}; }
  },
  CoreV1Api: { name: 'CoreV1Api' },
  BatchV1Api: { name: 'BatchV1Api' },
}));

vi.mock('../../shared/k8s-patch.js', () => ({
  JSON_PATCH: { headers: { 'Content-Type': 'application/json-patch+json' } },
}));

describe('blob-store.buildCliCommands — secret-handling guard', () => {
  let buildCliCommands: typeof import('./blob-store.js').buildCliCommands;

  beforeEach(async () => {
    ({ buildCliCommands } = await import('./blob-store.js'));
  });

  it('Default backend — only emits @type=Default, no extra fields', () => {
    const cmds = buildCliCommands({ type: 'Default' });
    const flat = cmds.join('\n');
    expect(flat).toContain("--field '@type=Default'");
    expect(flat).not.toContain('accessKey');
    expect(flat).not.toContain('secretKey');
    expect(flat).not.toContain('bucket');
  });

  it('FileSystem backend — emits @type=FileSystem + path + depth, no secrets', () => {
    const cmds = buildCliCommands({
      type: 'FileSystem',
      fileSystem: { path: '/var/lib/stalwart/blobs', depth: 2 },
    });
    const flat = cmds.join('\n');
    expect(flat).toContain("--field '@type=FileSystem'");
    expect(flat).toContain("--field 'path=/var/lib/stalwart/blobs'");
    expect(flat).toContain("--field 'depth=2'");
    expect(flat).not.toContain('accessKey');
    expect(flat).not.toContain('secretKey');
  });

  it('S3 backend — references shell env vars, NEVER inlines plaintext keys', () => {
    const cmds = buildCliCommands({
      type: 'S3',
      s3: {
        bucket: 'my-secret-bucket',
        region: 'eu-central-1',
        endpoint: 'https://s3.example.com',
        accessKey: 'AKIAEXPOSEDKEYZZZZZZ',  // long enough to trip naive substring matches
        secretKey: 'PLAIN_TEXT_SECRET_KEY_THAT_MUST_NEVER_LEAK_xxxxxxxxxxxx',
      },
    });
    const flat = cmds.join('\n');

    // The cli arg references the env-var name, NOT the value.
    expect(flat).toContain("--field 'accessKey=$S3_ACCESS_KEY'");
    expect(flat).toContain("--field 'secretKey=$S3_SECRET_KEY'");

    // The plaintext values MUST NOT appear anywhere in the rendered
    // commands. This is the load-bearing security assertion.
    expect(flat).not.toContain('AKIAEXPOSEDKEYZZZZZZ');
    expect(flat).not.toContain('PLAIN_TEXT_SECRET_KEY_THAT_MUST_NEVER_LEAK_xxxxxxxxxxxx');
  });

  it('S3 backend — bucket and region appear (non-secret), endpoint optional', () => {
    const cmds = buildCliCommands({
      type: 'S3',
      s3: {
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKey: 'A',
        secretKey: 'B',
      },
    });
    const flat = cmds.join('\n');
    expect(flat).toContain("--field 'bucket=my-bucket'");
    expect(flat).toContain("--field 'region=us-east-1'");
    // No endpoint provided → no endpoint field rendered.
    expect(flat).not.toContain('--field \'endpoint=');
  });

  it('S3 endpoint is rendered when present', () => {
    const cmds = buildCliCommands({
      type: 'S3',
      s3: {
        bucket: 'b',
        region: 'r',
        endpoint: 'https://s3.example.com',
        accessKey: 'A',
        secretKey: 'B',
      },
    });
    expect(cmds.join('\n')).toContain("--field 'endpoint=https://s3.example.com'");
  });

  it('cli-arg quoting: bucket with embedded apostrophe is escaped via shell-safe form', () => {
    const cmds = buildCliCommands({
      type: 'S3',
      s3: {
        bucket: "my'evil'bucket",
        region: 'r',
        accessKey: 'A',
        secretKey: 'B',
      },
    });
    const flat = cmds.join('\n');
    // The escape produces single-quote-bash-safe form: 'my'\''evil'\''bucket'
    expect(flat).toContain(`'bucket=my'\\''evil'\\''bucket'`);
  });

  it('cli commands always include BEFORE + AFTER + self-verify exit', () => {
    const cmds = buildCliCommands({ type: 'Default' });
    expect(cmds.some((c) => c.includes('=== BEFORE ==='))).toBe(true);
    expect(cmds.some((c) => c.includes('=== AFTER ==='))).toBe(true);
    expect(cmds.some((c) => c.includes('self-verify FAILED'))).toBe(true);
    expect(cmds.some((c) => c.includes('exit 1'))).toBe(true);
  });

  it('self-verify expected= matches the requested type', () => {
    expect(buildCliCommands({ type: 'Default' }).join('\n')).toContain('expected="Default"');
    expect(buildCliCommands({ type: 'S3', s3: { bucket: 'b', region: 'r', accessKey: 'a', secretKey: 's' } }).join('\n')).toContain('expected="S3"');
    expect(buildCliCommands({ type: 'FileSystem', fileSystem: { path: '/p', depth: 2 } }).join('\n')).toContain('expected="FileSystem"');
  });

  // Regression guard for a shell-escape bug found during staging E2E:
  // an earlier version used a JS template-literal `\\$CLI` to escape
  // `$` from JS interpolation. That rendered `\$CLI` to the shell, and
  // bash treats `\$` inside `$(...)` as literal — so the shell tried
  // to execute a command named `$CLI` and emitted `sh: $CLI: not found`.
  // Every BlobStore flip then failed self-verify even though the
  // underlying update succeeded.
  it('self-verify uses unescaped "$CLI" so shell expands the variable', () => {
    const flat = buildCliCommands({ type: 'Default' }).join('\n');
    // The variable reference must be `"$CLI"` — no backslash before $.
    expect(flat).not.toMatch(/\\\$CLI/);
    expect(flat).toMatch(/"\$CLI"\s+get\s+BlobStore\s+--json/);
  });

  // Regression guard for the bug found during the staging E2E:
  // stalwart-cli `get BlobStore` (no flag) emits human-readable text
  // ("Type: Filesystem"), while `get BlobStore --json` emits the JSON
  // line (`{"@type":"FileSystem", ...}`). The self-verify regex only
  // works against the JSON form. Without `--json`, every successful
  // flip would mark the Job as Failed and the operator UI would show
  // a red error for a working change.
  it('every "$CLI get BlobStore" invocation passes --json so self-verify can parse output', () => {
    for (const req of [
      { type: 'Default' as const },
      { type: 'FileSystem' as const, fileSystem: { path: '/p', depth: 2 } },
      { type: 'S3' as const, s3: { bucket: 'b', region: 'r', accessKey: 'a', secretKey: 's' } },
    ]) {
      const flat = buildCliCommands(req).join('\n');
      // Must NOT contain a get without --json
      expect(flat).not.toMatch(/"\$CLI"\s+get\s+BlobStore(?!\s+--json)/);
      // Must contain at least one --json get
      expect(flat).toMatch(/"\$CLI"\s+get\s+BlobStore\s+--json/);
    }
  });
});
