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
    imapServiceHost: 'stalwart-mail-v016.mail.svc.cluster.local',
    imapServicePort: 143,
    stalwartMasterUser: 'master',
    masterSecretName: 'roundcube-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    mode: 'merge-skip-duplicates' as const,
    downloadBase: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-1/components/mailboxes',
    downloads: [
      { address: 'a@example.com', token: '1.deadbeef' },
      { address: 'b@example.com', token: '2.cafebabe' },
    ],
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

  it('passes per-mailbox tokens via env vars (not embedded in script body)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }>; command: string[] }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    expect(env.find((e) => e.name === 'MAILBOX_TOKEN_0')?.value).toBe('1.deadbeef');
    expect(env.find((e) => e.name === 'MAILBOX_TOKEN_1')?.value).toBe('2.cafebabe');
    expect(env.find((e) => e.name === 'MAILBOX_ADDR_0')?.value).toBe('a@example.com');
    // Tokens are NOT in the rendered script body.
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toContain('1.deadbeef');
    expect(cmd).not.toContain('2.cafebabe');
  });

  it('mounts STALWART_MASTER_PASSWORD from the roundcube-secrets Secret (master-user proxy auth)', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const adminEnv = spec.spec.template.spec.containers[0]!.env.find((e) => e.name === 'STALWART_MASTER_PASSWORD');
    expect(adminEnv?.valueFrom?.secretKeyRef?.name).toBe('roundcube-secrets');
    expect(adminEnv?.valueFrom?.secretKeyRef?.key).toBe('STALWART_MASTER_PASSWORD');
  });

  it('script invokes curl (download), tar (extract), and restore-mailbox.py per address', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[]; image: string }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(spec.spec.template.spec.containers[0]!.image).toMatch(/mail-backup-tools/);
    expect(cmd).toContain('curl --fail-with-body');
    expect(cmd).toContain('tar -xzf');
    expect(cmd).toContain('/usr/local/bin/restore-mailbox.py');
    expect(cmd).not.toContain('stalwart-cli');
    // Authenticates via IMAP master-user proxy.
    expect(cmd).toContain('%master');
  });

  it('embeds the chosen mode in the script', () => {
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
  });
});
