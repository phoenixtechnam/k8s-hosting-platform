import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cscli-exec.js', () => ({
  cscliExec: vi.fn(),
  findCrowdsecPodName: vi.fn().mockResolvedValue('crowdsec-test-pod'),
}));
vi.mock('../container-console/service.js', () => ({
  createKubeConfig: vi.fn().mockReturnValue({}),
}));

import {
  addAllowlistEntry,
  isIpInAllowlist,
  listAllowlistEntries,
  removeAllowlistEntry,
} from './crowdsec-allowlists.js';
import { cscliExec } from './cscli-exec.js';

const mockedCscli = vi.mocked(cscliExec);

beforeEach(() => {
  mockedCscli.mockReset();
});

describe('addAllowlistEntry', () => {
  it('skips create when inspect succeeds (allowlist already exists)', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' }) // inspect → exists
      .mockResolvedValueOnce({ stdout: 'added', stderr: '' }); // add
    await addAllowlistEntry(undefined, { value: '198.51.100.5', scope: 'Ip', comment: 'office' }, 'user-1');
    expect(mockedCscli).toHaveBeenCalledTimes(2);
    expect(mockedCscli.mock.calls[0][2]).toEqual(['allowlists', 'inspect', 'admin-panel', '-o', 'json']);
    expect(mockedCscli.mock.calls[1][2]).toEqual([
      'allowlists', 'add', 'admin-panel', '198.51.100.5',
      '--comment', 'user-1:office',
    ]);
  });

  it('creates the allowlist when inspect fails (first-use path)', async () => {
    mockedCscli
      .mockRejectedValueOnce(new Error('allowlist not found')) // inspect → not exists
      .mockResolvedValueOnce({ stdout: 'created', stderr: '' }) // create
      .mockResolvedValueOnce({ stdout: 'added', stderr: '' }); // add
    await addAllowlistEntry(undefined, { value: '198.51.100.5', scope: 'Ip', comment: 'office' }, 'user-1');
    expect(mockedCscli).toHaveBeenCalledTimes(3);
    expect(mockedCscli.mock.calls[1][2]).toEqual([
      'allowlists', 'create', 'admin-panel',
      '--description', 'Operator-managed allowlist via the admin panel',
    ]);
  });

  it('swallows "already exists" on create (race-condition fallback)', async () => {
    mockedCscli
      .mockRejectedValueOnce(new Error('inspect failed')) // inspect → not exists
      .mockRejectedValueOnce(new Error('allowlist admin-panel already exists')) // create raced
      .mockResolvedValueOnce({ stdout: 'added', stderr: '' });
    await expect(
      addAllowlistEntry(undefined, { value: '10.1.2.3', scope: 'Ip', comment: 'monitoring' }, 'svc'),
    ).resolves.toBeDefined();
    expect(mockedCscli).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-"already exists" errors from create', async () => {
    mockedCscli
      .mockRejectedValueOnce(new Error('inspect failed'))
      .mockRejectedValueOnce(new Error('LAPI unreachable'));
    await expect(
      addAllowlistEntry(undefined, { value: '10.1.2.3', scope: 'Ip', comment: 'x' }, 'u'),
    ).rejects.toThrow(/LAPI unreachable/);
  });

  it('tags entries with actor:comment so list can split them back out', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    await addAllowlistEntry(undefined, { value: '1.2.3.4', scope: 'Ip', comment: 'my reason' }, 'sub-uuid');
    // args: ['allowlists','add','admin-panel',value,'--comment',comment] → index 5
    const commentArg = mockedCscli.mock.calls[1][2][5];
    expect(commentArg).toBe('sub-uuid:my reason');
  });

  it('strips colons from actor so OIDC subs with colons don\'t corrupt the addedBy split', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    // Some OIDC providers emit subs like "provider:user-id" — must not pollute the split.
    await addAllowlistEntry(undefined, { value: '1.2.3.4', scope: 'Ip', comment: 'reason' }, 'provider:user-id');
    const commentArg = mockedCscli.mock.calls[1][2][5];
    expect(commentArg).toBe('provider_user-id:reason');
  });
});

describe('removeAllowlistEntry', () => {
  it('rejects values that don\'t match the IP/CIDR regex', async () => {
    await expect(removeAllowlistEntry(undefined, 'rm -rf /')).rejects.toThrow(/invalid/);
    await expect(removeAllowlistEntry(undefined, '$(whoami)')).rejects.toThrow(/invalid/);
    expect(mockedCscli).not.toHaveBeenCalled();
  });

  it('parses "N element(s) removed" from cscli output', async () => {
    mockedCscli.mockResolvedValueOnce({ stdout: '1 element(s) removed', stderr: '' });
    const res = await removeAllowlistEntry(undefined, '198.51.100.5');
    expect(res.removed).toBe(1);
  });

  it('returns removed=0 when cscli doesn\'t report a count', async () => {
    mockedCscli.mockResolvedValueOnce({ stdout: 'not found', stderr: '' });
    const res = await removeAllowlistEntry(undefined, '198.51.100.5');
    expect(res.removed).toBe(0);
  });
});

describe('listAllowlistEntries', () => {
  it('parses cscli inspect JSON output', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ensureAllowlistExists
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          name: 'admin-panel',
          items: [
            { value: '198.51.100.5', description: 'user-1:office', created_at: '2026-05-20T10:00:00Z', expiration: null },
            { value: '10.1.2.0/24', description: 'svc:monitoring range', created_at: '2026-05-20T11:00:00Z', expiration: null },
          ],
        }),
        stderr: '',
      });
    const entries = await listAllowlistEntries(undefined);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ value: '198.51.100.5', scope: 'Ip', addedBy: 'user-1', comment: 'office' });
    expect(entries[1]).toMatchObject({ value: '10.1.2.0/24', scope: 'Range', addedBy: 'svc', comment: 'monitoring range' });
  });

  it('handles uppercase Items key (newer cscli versions)', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Items: [{ value: '1.2.3.4', description: 'a:b', created_at: '2026-05-20T10:00:00Z' }],
        }),
        stderr: '',
      });
    const entries = await listAllowlistEntries(undefined);
    expect(entries).toHaveLength(1);
  });

  it('returns [] when allowlist is empty (cscli throws)', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('allowlist is empty'));
    const entries = await listAllowlistEntries(undefined);
    expect(entries).toEqual([]);
  });

  it('splits comment with no colon correctly (legacy entries)', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          items: [{ value: '1.2.3.4', description: 'legacy plaintext', created_at: '2026-05-20T10:00:00Z' }],
        }),
        stderr: '',
      });
    const entries = await listAllowlistEntries(undefined);
    expect(entries[0].addedBy).toBeNull();
    expect(entries[0].comment).toBe('legacy plaintext');
  });
});

describe('isIpInAllowlist', () => {
  it('returns true when cscli check reports a match', async () => {
    mockedCscli.mockResolvedValueOnce({ stdout: '1.2.3.4 is in allowlist admin-panel', stderr: '' });
    await expect(isIpInAllowlist(undefined, '1.2.3.4')).resolves.toBe(true);
  });

  it('returns true on cscli error (fail-CLOSED for safety)', async () => {
    // SAFETY-CRITICAL: if cscli errors, callers must refuse to ban because
    // we can\'t verify the IP isn\'t allowlisted. See doc comment in source.
    mockedCscli.mockRejectedValueOnce(new Error('not found'));
    await expect(isIpInAllowlist(undefined, '1.2.3.4')).resolves.toBe(true);
  });

  it('returns true when cscli reports no match (negative output)', async () => {
    // Edge case: cscli succeeds but the output doesn\'t match the positive
    // regex → we treat as "not in allowlist" → false. This is the OK path
    // (the explicit-negative is trusted, the implicit-unknown fails closed).
    mockedCscli.mockResolvedValueOnce({ stdout: '1.2.3.4 not allowlisted', stderr: '' });
    await expect(isIpInAllowlist(undefined, '1.2.3.4')).resolves.toBe(false);
  });

  it('rejects invalid IP without calling cscli', async () => {
    await expect(isIpInAllowlist(undefined, 'not-an-ip')).resolves.toBe(false);
    expect(mockedCscli).not.toHaveBeenCalled();
  });
});
