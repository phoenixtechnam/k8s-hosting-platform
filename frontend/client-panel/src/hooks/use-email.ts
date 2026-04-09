import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface EmailDomain {
  readonly id: string;
  readonly domainId: string;
  readonly domainName: string;
  readonly enabled: number;
  readonly webmailEnabled?: number;
  readonly maxMailboxes: number;
  readonly maxQuotaMb: number;
  readonly mailboxCount?: number;
  readonly catchAllAddress?: string | null;
  readonly spamThresholdJunk?: string;
  readonly spamThresholdReject?: string;
  readonly dnsMode?: string;
}

// ─── Email domain update (settings tab) ─────────────────────────────

export interface DnsRecordDisplay {
  readonly type: string;
  readonly name: string;
  readonly value: string;
  readonly ttl: number;
  readonly priority: number | null;
}

export interface DnsRecordsResponse {
  readonly dnsMode: string;
  readonly manualRequired: boolean;
  readonly mailServerHostname: string;
  readonly records: readonly DnsRecordDisplay[];
}

export interface Mailbox {
  readonly id: string;
  readonly localPart: string;
  readonly fullAddress: string;
  readonly displayName: string | null;
  readonly quotaMb: number;
  readonly usedMb: number;
  readonly status: string;
  readonly mailboxType: string;
  readonly autoReply: number;
  readonly autoReplySubject?: string | null;
  readonly autoReplyBody?: string | null;
  readonly createdAt: string;
}

interface EmailAlias {
  readonly id: string;
  readonly sourceAddress: string;
  readonly destinationAddresses: readonly string[];
  readonly enabled: number;
}

interface DomainsResponse { readonly data: readonly EmailDomain[] }
interface MailboxesResponse { readonly data: readonly Mailbox[] }
interface MailboxResponse { readonly data: Mailbox }
interface AliasesResponse { readonly data: readonly EmailAlias[] }
interface AliasResponse { readonly data: EmailAlias }
interface WebmailTokenResponse { readonly data: { token: string; mailbox: string; webmailUrl: string } }

export function useEmailDomains(clientId?: string) {
  return useQuery({
    queryKey: ['email-domains', clientId],
    queryFn: () => apiFetch<DomainsResponse>(`/api/v1/clients/${clientId}/email/domains`),
    enabled: !!clientId,
  });
}

export function useEnableEmailDomain(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, input }: { domainId: string; input: Record<string, unknown> }) =>
      apiFetch(`/api/v1/clients/${clientId}/email/domains/${domainId}/enable`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-domains', clientId] }),
  });
}

export function useUpdateEmailDomain(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, input }: { domainId: string; input: Record<string, unknown> }) =>
      apiFetch(`/api/v1/clients/${clientId}/email/domains/${domainId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-domains', clientId] }),
  });
}

export function useEmailDomainDnsRecords(clientId?: string, domainId?: string) {
  return useQuery({
    queryKey: ['email-domain-dns-records', clientId, domainId],
    queryFn: () =>
      apiFetch<{ data: DnsRecordsResponse }>(
        `/api/v1/clients/${clientId}/email/domains/${domainId}/dns-records`,
      ),
    enabled: !!clientId && !!domainId,
  });
}

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
      apiFetch<MailboxResponse>(`/api/v1/clients/${clientId}/email/domains/${emailDomainId}/mailboxes`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', clientId] }),
  });
}

export function useUpdateMailbox(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, unknown> }) =>
      apiFetch<MailboxResponse>(`/api/v1/clients/${clientId}/mailboxes/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', clientId] }),
  });
}

export function useDeleteMailbox(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/v1/clients/${clientId}/mailboxes/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', clientId] }),
  });
}

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
      apiFetch<AliasResponse>(`/api/v1/clients/${clientId}/email/domains/${emailDomainId}/aliases`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-aliases', clientId] }),
  });
}

export function useDeleteEmailAlias(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/v1/clients/${clientId}/email/aliases/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-aliases', clientId] }),
  });
}

export function useWebmailToken() {
  return useMutation({
    mutationFn: (mailboxId: string) =>
      apiFetch<WebmailTokenResponse>('/api/v1/email/webmail-token', { method: 'POST', body: JSON.stringify({ mailbox_id: mailboxId }) }),
  });
}
