import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveVersionAwareDeploymentConfig } = await import('./service.js');

// Minimal catalog entry shape
type MockEntry = {
  id: string;
  code: string;
  image: string | null;
  defaultVersion: string | null;
  components: unknown;
  volumes: unknown;
  envVars: unknown;
  networking: unknown;
  resources: unknown;
};

function createEntry(overrides: Partial<MockEntry> = {}): MockEntry {
  return {
    id: 'entry-1',
    code: 'postgresql',
    image: 'postgres:latest',
    defaultVersion: '18',
    components: [
      { name: 'postgresql', type: 'deployment', image: 'postgres:latest', ports: [{ port: 5432, protocol: 'tcp' }] },
    ],
    volumes: [
      { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql/data' },
    ],
    envVars: { generated: ['POSTGRES_PASSWORD'], fixed: {} },
    networking: { ingress_ports: [] },
    resources: { recommended: { cpu: '0.25', memory: '512Mi', storage: '5Gi' } },
    ...overrides,
  };
}

function createMockDb(versionRecord: unknown = null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => versionRecord ? [versionRecord] : []),
      })),
    })),
  };
}

describe('resolveVersionAwareDeploymentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to entry-level volumes when no version record exists', async () => {
    const entry = createEntry();
    const db = createMockDb(null); // No version record found

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      '17',
    );

    expect(result.volumes).toEqual([
      { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql/data' },
    ]);
    expect(result.fixedEnvVars).toEqual({});
    expect(result.generatedEnvKeys).toEqual(['POSTGRES_PASSWORD']);
    expect(result.installedVersion).toBeNull();
  });

  it('uses entry-level volumes when version has no volume override', async () => {
    const entry = createEntry();
    const versionRecord = {
      version: '17',
      components: [{ name: 'postgresql', image: 'postgres:17' }],
      volumes: null,
      envVars: null,
    };
    const db = createMockDb(versionRecord);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      '17',
    );

    expect(result.volumes).toEqual([
      { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql/data' },
    ]);
    expect(result.installedVersion).toBe('17');
    // Version-specific image should be used
    expect(result.components[0].image).toBe('postgres:17');
  });

  it('REPLACES entry-level volumes with version-specific volumes', async () => {
    const entry = createEntry();
    const versionRecord = {
      version: '18',
      components: [{ name: 'postgresql', image: 'postgres:18' }],
      volumes: [
        { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql' },
      ],
      envVars: null,
    };
    const db = createMockDb(versionRecord);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      '18',
    );

    expect(result.volumes).toEqual([
      { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql' },
    ]);
    expect(result.installedVersion).toBe('18');
    expect(result.components[0].image).toBe('postgres:18');
  });

  it('merges version-level fixed env vars with entry-level (version wins on conflict)', async () => {
    const entry = createEntry({
      envVars: {
        generated: ['POSTGRES_PASSWORD'],
        fixed: { POSTGRES_INITDB_ARGS: '--encoding=UTF8', PGDATA: '/var/lib/postgresql/data' },
      },
    });
    const versionRecord = {
      version: '18',
      components: [{ name: 'postgresql', image: 'postgres:18' }],
      volumes: null,
      envVars: { fixed: { PGDATA: '/var/lib/postgresql/18/docker' } },
    };
    const db = createMockDb(versionRecord);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      '18',
    );

    // Entry-level preserved
    expect(result.fixedEnvVars.POSTGRES_INITDB_ARGS).toBe('--encoding=UTF8');
    // Version-level wins on conflict
    expect(result.fixedEnvVars.PGDATA).toBe('/var/lib/postgresql/18/docker');
    // Generated keys still from entry level
    expect(result.generatedEnvKeys).toEqual(['POSTGRES_PASSWORD']);
  });

  it('uses default version when no target version provided', async () => {
    const entry = createEntry({ defaultVersion: '18' });
    const versionRecord = {
      version: '18',
      components: [{ name: 'postgresql', image: 'postgres:18' }],
      volumes: null,
      envVars: null,
    };
    const db = createMockDb(versionRecord);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      null,
    );

    expect(result.installedVersion).toBe('18');
  });

  it('does not query DB when no version is requested and no default version exists', async () => {
    const entry = createEntry({ defaultVersion: null });
    const db = createMockDb(null);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      null,
    );

    // Should use entry-level values only
    expect(result.installedVersion).toBeNull();
    expect(result.volumes).toEqual([
      { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql/data' },
    ]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('handles empty volumes array in version record as "no override"', async () => {
    const entry = createEntry();
    const versionRecord = {
      version: '17',
      components: [{ name: 'postgresql', image: 'postgres:17' }],
      volumes: [], // empty array
      envVars: null,
    };
    const db = createMockDb(versionRecord);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      '17',
    );

    // Empty version volumes should fall back to entry volumes
    expect(result.volumes).toEqual([
      { local_path: 'databases/postgresql', container_path: '/var/lib/postgresql/data' },
    ]);
  });

  it('handles entry without env vars', async () => {
    const entry = createEntry({ envVars: null });
    const db = createMockDb(null);

    const result = await resolveVersionAwareDeploymentConfig(
      db as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[0],
      entry as unknown as Parameters<typeof resolveVersionAwareDeploymentConfig>[1],
      null,
    );

    expect(result.fixedEnvVars).toEqual({});
    expect(result.generatedEnvKeys).toEqual([]);
  });
});
