import { describe, it, expect } from 'vitest';
import { buildMailboxesComponentJobSpec } from './mailboxes.js';

describe('buildMailboxesComponentJobSpec', () => {
  const baseInput = {
    jobName: 'bk-mbox-bkp-test',
    mailNamespace: 'mail',
    clientId: 'abc',
    backupId: 'bkp-test',
    toolsImage: 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest',
    imapServiceHost: 'stalwart-mail-v016.mail.svc.cluster.local',
    imapServicePort: 143,
    stalwartMasterUser: 'master',
    masterSecretName: 'roundcube-secrets',
    masterSecretKey: 'STALWART_MASTER_PASSWORD',
    uploadBase: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-test/components/mailboxes',
    uploads: [
      { address: 'user1@example.com', token: '1.deadbeef' },
      { address: 'user2@example.com', token: '2.cafebabe' },
    ],
  };

  it('runs in the mail namespace', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as { metadata: { namespace: string } };
    expect(spec.metadata.namespace).toBe('mail');
  });

  it('carries platform.io/component=backup-files so the existing NetworkPolicy applies', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    expect(spec.metadata.labels['platform.io/sub-component']).toBe('backup-mailboxes');
  });

  it('passes per-mailbox tokens via env vars (not embedded in script body)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }>; command: string[] }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    const envNames = env.map((e) => e.name).sort();
    expect(envNames).toContain('MAILBOX_TOKEN_0');
    expect(envNames).toContain('MAILBOX_TOKEN_1');
    expect(envNames).toContain('MAILBOX_ADDR_0');
    expect(envNames).toContain('MAILBOX_ADDR_1');
    expect(envNames).toContain('STALWART_MASTER_PASSWORD');
    // Tokens are NOT in the rendered script body (only the env var name reference).
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toContain('1.deadbeef');
    expect(cmd).not.toContain('2.cafebabe');
  });

  it('mounts STALWART_MASTER_PASSWORD from the roundcube-secrets Secret (master-user proxy auth)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }> }> } } };
    };
    const cred = spec.spec.template.spec.containers[0]!.env.find((e) => e.name === 'STALWART_MASTER_PASSWORD');
    expect(cred?.valueFrom?.secretKeyRef?.name).toBe('roundcube-secrets');
    expect(cred?.valueFrom?.secretKeyRef?.key).toBe('STALWART_MASTER_PASSWORD');
  });

  it('runs capture-mailbox.sh per address and streams to platform-api uploadBase (no stalwart-cli)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[]; image: string }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // mail-backup-tools image (alpine + mbsync + python3 + curl).
    expect(spec.spec.template.spec.containers[0]!.image).toMatch(/mail-backup-tools/);
    // Per-address loop calls capture-mailbox.sh — never stalwart-cli.
    expect(cmd).toContain('/usr/local/bin/capture-mailbox.sh');
    expect(cmd).not.toContain('stalwart-cli');
    expect(cmd).toContain(baseInput.uploadBase);
  });

  it('passes IMAP host/port/master via env vars', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } };
    };
    const env = spec.spec.template.spec.containers[0]!.env;
    const find = (n: string) => env.find((e) => e.name === n)?.value;
    expect(find('IMAP_HOST')).toBe('stalwart-mail-v016.mail.svc.cluster.local');
    expect(find('IMAP_PORT')).toBe('143');
    expect(find('STALWART_MASTER_USER')).toBe('master');
  });

  it('rejects unsafe addresses (defence against shell injection from forged DB rows)', () => {
    expect(() => buildMailboxesComponentJobSpec({
      ...baseInput,
      uploads: [{ address: 'evil$(rm -rf /)@x.com', token: 't' }],
    })).toThrow(/invalid address/);
    expect(() => buildMailboxesComponentJobSpec({
      ...baseInput,
      uploads: [{ address: 'a@b.com; rm -rf /', token: 't' }],
    })).toThrow(/invalid address/);
  });

  it('sets backoffLimit=0 (fail loud)', () => {
    const spec = buildMailboxesComponentJobSpec(baseInput) as { spec: { backoffLimit: number } };
    expect(spec.spec.backoffLimit).toBe(0);
  });
});
