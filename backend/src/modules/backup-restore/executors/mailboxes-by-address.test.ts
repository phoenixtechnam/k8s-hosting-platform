import { describe, it, expect } from 'vitest';
import { buildMailboxesByAddressJobSpec } from './mailboxes-by-address.js';

describe('buildMailboxesByAddressJobSpec', () => {
  const baseInput = {
    jobName: 'rs-mbox-item-1',
    mailNamespace: 'mail',
    clientId: 'client-acme',
    cartId: 'rstr-1',
    itemId: 'item-1',
    jobImage: 'docker.io/stalwartlabs/stalwart:v0.16.3',
    stalwartMgmtUrl: 'http://stalwart-mail-v016.mail.svc:8080',
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

  it('mounts STALWART_RECOVERY_ADMIN from the stalwart-admin-creds Secret', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const adminEnv = spec.spec.template.spec.containers[0]!.env.find((e) => e.name === 'STALWART_RECOVERY_ADMIN');
    expect(adminEnv?.valueFrom?.secretKeyRef?.name).toBe('stalwart-admin-creds');
    expect(adminEnv?.valueFrom?.secretKeyRef?.key).toBe('recoveryAdmin');
  });

  it('script invokes both `curl` (download) and `stalwart-cli account import` per address', () => {
    const spec = buildMailboxesByAddressJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('curl --fail-with-body');
    expect(cmd).toContain('stalwart-cli');
    expect(cmd).toContain('account import');
  });
});
