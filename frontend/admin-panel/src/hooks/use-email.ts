import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Email Domains ───

interface EmailDomain {
  readonly id: string;
  readonly domainId: string;
  readonly clientId: string;
  readonly domainName: string;
  readonly enabled: number;
  readonly dkimSelector: string;
  readonly dkimPublicKey: string | null;
  readonly maxMailboxes: number;
  readonly maxQuotaMb: number;
  readonly catchAllAddress: string | null;
  readonly mxProvisioned: number;
  readonly spfProvisioned: number;
  readonly dkimProvisioned: number;
  readonly dmarcProvisioned: number;
  readonly spamThresholdJunk: string;
  readonly spamThresholdReject: string;
  readonly mailboxCount?: number;
  readonly createdAt: string;
}

interface EmailDomainsResponse { readonly data: readonly EmailDomain[] }
interface EmailDomainResponse { readonly data: EmailDomain }

export function useAdminEmailDomains() {
  return useQuery({
    queryKey: ['admin-email-domains'],
    queryFn: () => apiFetch<EmailDomainsResponse>('/api/v1/admin/email/domains'),
  });
}

export function useEmailDomains(clientId?: string) {
  return useQuery({
    queryKey: ['email-domains', clientId],
    queryFn: () => apiFetch<EmailDomainsResponse>(`/api/v1/clients/${clientId}/email/domains`),
    enabled: !!clientId,
  });
}

export function useEnableEmailDomain(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, input }: { domainId: string; input: Record<string, unknown> }) =>
      apiFetch<EmailDomainResponse>(`/api/v1/clients/${clientId}/email/domains/${domainId}/enable`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-domains', clientId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

export function useDisableEmailDomain(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/email/domains/${domainId}/disable`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-domains', clientId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

export function useUpdateEmailDomain(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, input }: { domainId: string; input: Record<string, unknown> }) =>
      apiFetch<EmailDomainResponse>(`/api/v1/clients/${clientId}/email/domains/${domainId}`, {
        method: 'PATCH', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-domains', clientId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

// ─── Mailboxes ───

interface Mailbox {
  readonly id: string;
  readonly emailDomainId: string;
  readonly clientId: string;
  readonly localPart: string;
  readonly fullAddress: string;
  readonly displayName: string | null;
  readonly quotaMb: number;
  readonly usedMb: number;
  readonly status: string;
  readonly mailboxType: string;
  readonly autoReply: number;
  readonly autoReplySubject: string | null;
  readonly createdAt: string;
}

interface MailboxesResponse { readonly data: readonly Mailbox[] }
interface MailboxResponse { readonly data: Mailbox }

export function useMailboxes(clientId?: string) {
  return useQuery({
    queryKey: ['mailboxes', clientId],
    queryFn: () => apiFetch<MailboxesResponse>(`/api/v1/clients/${clientId}/mailboxes`),
    enabled: !!clientId,
  });
}

export function useCreateMailbox(clientId: string, emailDomainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<MailboxResponse>(`/api/v1/clients/${clientId}/email/domains/${emailDomainId}/mailboxes`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', clientId] }),
  });
}

export function useUpdateMailbox(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, unknown> }) =>
      apiFetch<MailboxResponse>(`/api/v1/clients/${clientId}/mailboxes/${id}`, {
        method: 'PATCH', body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', clientId] }),
  });
}

export function useDeleteMailbox(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/mailboxes/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', clientId] }),
  });
}

// ─── Email Aliases ───

interface EmailAlias {
  readonly id: string;
  readonly emailDomainId: string;
  readonly clientId: string;
  readonly sourceAddress: string;
  readonly destinationAddresses: readonly string[];
  readonly enabled: number;
  readonly createdAt: string;
}

interface AliasesResponse { readonly data: readonly EmailAlias[] }
interface AliasResponse { readonly data: EmailAlias }

export function useEmailAliases(clientId?: string) {
  return useQuery({
    queryKey: ['email-aliases', clientId],
    queryFn: () => apiFetch<AliasesResponse>(`/api/v1/clients/${clientId}/email/aliases`),
    enabled: !!clientId,
  });
}

export function useCreateEmailAlias(clientId: string, emailDomainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<AliasResponse>(`/api/v1/clients/${clientId}/email/domains/${emailDomainId}/aliases`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-aliases', clientId] }),
  });
}

export function useDeleteEmailAlias(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/clients/${clientId}/email/aliases/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-aliases', clientId] }),
  });
}

// ─── SMTP Relay ───

interface SmtpRelay {
  readonly id: string;
  readonly name: string;
  readonly providerType: string;
  readonly isDefault: number;
  readonly enabled: number;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly authUsername: string | null;
  readonly region: string | null;
  readonly lastTestedAt: string | null;
  readonly lastTestStatus: string | null;
  readonly createdAt: string;
}

interface RelaysResponse { readonly data: readonly SmtpRelay[] }
interface RelayResponse { readonly data: SmtpRelay }
interface TestResult { readonly data: { status: string; message?: string } }

export function useSmtpRelays() {
  return useQuery({
    queryKey: ['smtp-relays'],
    queryFn: () => apiFetch<RelaysResponse>('/api/v1/admin/email/smtp-relays'),
  });
}

export function useCreateSmtpRelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<RelayResponse>('/api/v1/admin/email/smtp-relays', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp-relays'] }),
  });
}

export function useDeleteSmtpRelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/email/smtp-relays/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp-relays'] }),
  });
}

export function useTestSmtpRelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<TestResult>(`/api/v1/admin/email/smtp-relays/${id}/test`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp-relays'] }),
  });
}

// ─── Webmail Token ───

interface WebmailTokenResponse { readonly data: { token: string; mailbox: string; webmailUrl: string } }

export function useWebmailToken() {
  return useMutation({
    mutationFn: (mailboxId: string) =>
      apiFetch<WebmailTokenResponse>('/api/v1/email/webmail-token', {
        method: 'POST', body: JSON.stringify({ mailbox_id: mailboxId }),
      }),
  });
}

interface AccessibleMailboxesResponse { readonly data: readonly Mailbox[] }

export function useAccessibleMailboxes() {
  return useQuery({
    queryKey: ['accessible-mailboxes'],
    queryFn: () => apiFetch<AccessibleMailboxesResponse>('/api/v1/email/accessible-mailboxes'),
  });
}
