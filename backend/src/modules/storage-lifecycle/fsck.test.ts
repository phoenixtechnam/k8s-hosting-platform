import { describe, it, expect } from 'vitest';
import { buildFsckScript } from './fsck.js';

describe('buildFsckScript', () => {
  it('runs xfs_repair -n -v in dry-run mode for xfs', () => {
    const script = buildFsckScript('xfs', true);
    expect(script).toMatch(/apk add --no-cache xfsprogs/);
    expect(script).toMatch(/xfs_repair -n -v "\$DEV"/);
    // No -L (zero log) — destructive flag must be excluded.
    expect(script).not.toMatch(/-L/);
  });

  it('runs xfs_repair -v (no -n) in repair mode for xfs', () => {
    const script = buildFsckScript('xfs', false);
    expect(script).toMatch(/xfs_repair -v "\$DEV"/);
    expect(script).not.toMatch(/xfs_repair -n/);
  });

  it('runs e2fsck -n -fv in dry-run mode for ext4', () => {
    const script = buildFsckScript('ext4', true);
    expect(script).toMatch(/apk add --no-cache e2fsprogs/);
    expect(script).toMatch(/e2fsck -n -fv "\$DEV"/);
  });

  it('runs e2fsck -y -fv in repair mode for ext4', () => {
    const script = buildFsckScript('ext4', false);
    expect(script).toMatch(/e2fsck -y -fv "\$DEV"/);
  });

  it('treats ext3/ext2 the same as ext4 (e2fsck handles them all)', () => {
    expect(buildFsckScript('ext3', true)).toMatch(/e2fsck -n -fv/);
    expect(buildFsckScript('ext2', false)).toMatch(/e2fsck -y -fv/);
  });

  it('matches case-insensitively', () => {
    expect(buildFsckScript('XFS', true)).toMatch(/xfs_repair/);
    expect(buildFsckScript('Ext4', true)).toMatch(/e2fsck/);
  });

  it('rejects unsupported filesystems with exit 64', () => {
    const script = buildFsckScript('btrfs', true);
    expect(script).toMatch(/unsupported fsType 'btrfs'/);
    expect(script).toMatch(/exit 64/);
    expect(script).not.toMatch(/xfs_repair|e2fsck/);
  });

  it('checks block-device existence before running the tool', () => {
    const script = buildFsckScript('xfs', true);
    expect(script).toMatch(/\[ -b "\$DEV" \]/);
    expect(script).toMatch(/exit 65/); // missing-device sentinel
  });
});
