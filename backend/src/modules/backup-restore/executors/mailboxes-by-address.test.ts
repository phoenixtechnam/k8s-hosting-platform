import { describe, it, expect } from 'vitest';
import { buildMailboxesByAddressJobSpec } from './mailboxes-by-address.js';

describe('buildMailboxesByAddressJobSpec', () => {
  const baseInput = {
    jobName: 'rs-mbox-item-1',
    mailNamespace: 'mail',
    clientId: 'client-acme',
    cartId: 'rstr-1',
    itemId: 'item-1',
    toolsImage: 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest',
    jmapEndpoint: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    stalwartMasterUser: 'master@master.local',
    masterSecretName: 'roundcube-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    mode: 'merge-skip-duplicates' as const,
    downloadBase: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-1/components/mailboxes',
    downloads: [
      { address: 'a@example.com', token: '1.deadbeef' },
      { address: 'b@example.com', token: '2.cafebabe' },
    ],
    workers: 16,
  };

  it('runs in the mail namespace', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as { metadata: { namespace: string } };
    expect(spec.metadata.namespace).toBe('mail');
  });

  it('labels with platform.io/component=restore-files (matches tightened NetworkPolicy)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.metadata.labels['platform.io/sub-component']).toBe('restore-mailboxes');
    expect(spec.metadata.labels['platform.io/restore-cart']).toBe('rstr-1');
  });

  it('rejects shell-special and URL-special chars in addresses (defence-in-depth)', () => {
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      downloads: [{ address: 'a;rm -rf /@example.com', token: '1.deadbeef' }],
    })).toThrow(/invalid address/);
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      downloads: [{ address: 'a@example.com?attack', token: '1.deadbeef' }],
    })).toThrow(/invalid address/);
  });

  it('rejects unsafe jmapEndpoint', () => {
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      jmapEndpoint: 'http://example.com$(curl evil)',
    })).toThrow(/invalid jmapEndpoint/);
    expect(() => buildMailboxesByAddressJobSpec({
      ...baseInput,
      jmapEndpoint: 'ftp://example.com',
    })).toThrow(/invalid jmapEndpoint/);
  });

  it('rejects out-of-range worker counts', () => {
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, workers: 0 }))
      .toThrow(/invalid workers/);
    expect(() => buildMailboxesByAddressJobSpec({ ...baseInput, workers: 65 }))
      .toThrow(/invalid workers/);
  });

  it('embeds tokens in the script via POSIX case dispatch (no MAILBOX_TOKEN_* env)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }>; command: string[] }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    // No more per-address env vars — values are baked into the case statement.
    expect(env.find((e) => e.name?.startsWith('MAILBOX_TOKEN_'))).toBeUndefined();
    expect(env.find((e) => e.name?.startsWith('MAILBOX_ADDR_'))).toBeUndefined();
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // case "$i" dispatch contains the literal address + token.
    expect(cmd).toContain('0) ADDR="a@example.com"; TOKEN="1.deadbeef"');
    expect(cmd).toContain('1) ADDR="b@example.com"; TOKEN="2.cafebabe"');
  });

  it('mounts STALWART_MASTER_PASSWORD from the roundcube-secrets Secret (master-user proxy auth)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const adminEnv = spec.spec.template.spec.containers[0]!.env.find((e) => e.name === 'STALWART_MASTER_PASSWORD');
    expect(adminEnv?.valueFrom?.secretKeyRef?.name).toBe('roundcube-secrets');
    expect(adminEnv?.valueFrom?.secretKeyRef?.key).toBe('STALWART_MASTER_PASSWORD');
  });

  it('script invokes curl (download), tar (extract), and jmap-restore.py per address', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[]; image: string }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(spec.spec.template.spec.containers[0]!.image).toMatch(/mail-backup-tools/);
    expect(cmd).toContain('curl --fail-with-body');
    expect(cmd).toContain('tar -xzf');
    expect(cmd).toContain('/usr/local/bin/jmap-restore.py');
    // No longer using stalwart-cli or restore-mailbox.py (IMAP path).
    expect(cmd).not.toContain('stalwart-cli');
    expect(cmd).not.toContain('restore-mailbox.py');
    // jmap-restore.py authenticates via master-user proxy.
    expect(cmd).toContain('--master-user "master@master.local"');
    expect(cmd).toContain('--auth-pass-env STALWART_MASTER_PASSWORD');
  });

  it('embeds the chosen mode and worker count in the script', () => {
    const spec1 = buildMailboxesByAddressJobSpec({ ...baseInput, mode: 'merge-skip-duplicates' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec1.spec.template.spec.containers[0]!.command.join(' ')).toContain('MODE=merge-skip-duplicates');

    const spec2 = buildMailboxesByAddressJobSpec({ ...baseInput, mode: 'merge-overwrite' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec2.spec.template.spec.containers[0]!.command.join(' ')).toContain('MODE=merge-overwrite');

    const spec3 = buildMailboxesByAddressJobSpec({ ...baseInput, mode: 'replace' }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec3.spec.template.spec.containers[0]!.command.join(' ')).toContain('MODE=replace');

    const spec4 = buildMailboxesByAddressJobSpec({ ...baseInput, workers: 24 }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    expect(spec4.spec.template.spec.containers[0]!.command.join(' ')).toContain('WORKERS=24');
  });
});
