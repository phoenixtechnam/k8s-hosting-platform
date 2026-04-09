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

// ─── Phase 3 T1.1 — DKIM key rotation ──────────────────────────────

export interface DkimKey {
  readonly id: string;
  readonly emailDomainId: string;
  readonly selector: string;
  readonly status: 'pending' | 'active' | 'retired';
  readonly dnsRecordValue: string;
  readonly dnsVerifiedAt: string | null;
  readonly activatedAt: string | null;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DkimKeysResponse { readonly data: readonly DkimKey[] }

export interface DkimRotateResult {
  readonly keyId: string;
  readonly newSelector: string;
  readonly mode: 'primary' | 'cname' | 'secondary';
  readonly status: 'pending' | 'active';
  readonly manualDnsRequired: boolean;
  readonly dnsRecordName: string;
  readonly dnsRecordValue: string;
}

interface DkimRotateResponse { readonly data: DkimRotateResult }

export function useDkimKeys(clientId?: string, domainId?: string) {
  return useQuery({
    queryKey: ['dkim-keys', clientId, domainId],
    queryFn: () => apiFetch<DkimKeysResponse>(`/api/v1/clients/${clientId}/email/domains/${domainId}/dkim/keys`),
    enabled: !!clientId && !!domainId,
  });
}

export function useRotateDkimKey(clientId: string, domainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<DkimRotateResponse>(`/api/v1/clients/${clientId}/email/domains/${domainId}/dkim/rotate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dkim-keys', clientId, domainId] });
    },
  });
}

export function useActivateDkimKey(clientId: string, domainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      apiFetch<{ data: { id: string; status: string } }>(
        `/api/v1/clients/${clientId}/email/domains/${domainId}/dkim/keys/${keyId}/activate`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dkim-keys', clientId, domainId] });
    },
  });
}

// ─── Phase 3 T5.1 — Mail submit credentials (sendmail compat) ─────

export interface MailSubmitCredentialInfo {
  readonly exists: boolean;
  readonly id?: string;
  readonly username?: string;
  readonly createdAt?: string;
  readonly lastUsedAt?: string | null;
}

export interface MailSubmitRotateResult {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly pushedToPvc: boolean;
  readonly pushError?: string;
}

export function useMailSubmitCredential(clientId?: string) {
  return useQuery({
    queryKey: ['mail-submit-credential', clientId],
    queryFn: () =>
      apiFetch<{ data: MailSubmitCredentialInfo }>(`/api/v1/clients/${clientId}/mail/submit-credential`),
    enabled: !!clientId,
  });
}

export function useRotateMailSubmitCredential(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { note?: string; pushToPvc?: boolean }) =>
      apiFetch<{ data: MailSubmitRotateResult }>(
        `/api/v1/clients/${clientId}/mail/submit-credential/rotate`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mail-submit-credential', clientId] });
    },
  });
}

// ─── Phase 3 T2.1 — IMAPSync job runner ───────────────────────────

export type ImapSyncJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ImapSyncJob {
  readonly id: string;
  readonly clientId: string;
  readonly mailboxId: string;
  readonly sourceHost: string;
  readonly sourcePort: number;
  readonly sourceUsername: string;
  readonly sourceSsl: boolean;
  readonly options: Record<string, unknown>;
  readonly status: ImapSyncJobStatus;
  readonly k8sJobName: string | null;
  readonly k8sNamespace: string;
  readonly logTail: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateImapSyncJobInput {
  readonly mailbox_id: string;
  readonly source_host: string;
  readonly source_port: number;
  readonly source_username: string;
  readonly source_password: string;
  readonly source_ssl: boolean;
  readonly options?: {
    readonly automap?: boolean;
    readonly noFolderSizes?: boolean;
    readonly dryRun?: boolean;
    readonly excludeFolders?: readonly string[];
  };
}

export function useImapSyncJobs(clientId?: string) {
  return useQuery({
    queryKey: ['imapsync-jobs', clientId],
    queryFn: () =>
      apiFetch<{ data: readonly ImapSyncJob[] }>(`/api/v1/clients/${clientId}/mail/imapsync`),
    enabled: !!clientId,
    // TanStack v5 infers the callback parameter as Query<TData,...>,
    // so query.state.data is already typed as the queryFn return
    // type. No cast needed — letting TypeScript keep the inference
    // means a future envelope rename will be caught at compile time.
    refetchInterval: (query) => {
      const hasRunning = query.state.data?.data?.some(
        (j) => j.status === 'running' || j.status === 'pending',
      );
      return hasRunning ? 5000 : false;
    },
  });
}

export function useCreateImapSyncJob(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateImapSyncJobInput) =>
      apiFetch<{ data: ImapSyncJob }>(`/api/v1/clients/${clientId}/mail/imapsync`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imapsync-jobs', clientId] }),
  });
}

export function useCancelImapSyncJob(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiFetch<{ data: { id: string; status: string } }>(
        `/api/v1/clients/${clientId}/mail/imapsync/${jobId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imapsync-jobs', clientId] }),
  });
}

// ─── Rate limit inspection (Round B) ─────────────────────────────

export interface RateLimitInfo {
  readonly limitPerHour: number;
  readonly source: 'client_override' | 'platform_default' | 'hardcoded_default' | 'suspended';
  readonly suspended: boolean;
}

export function useMailRateLimit(clientId?: string) {
  return useQuery({
    queryKey: ['mail-rate-limit', clientId],
    queryFn: () =>
      apiFetch<{ data: RateLimitInfo }>(`/api/v1/clients/${clientId}/mail/rate-limit`),
    enabled: !!clientId,
  });
}

// ─── Mailbox usage / plan limit (Phase 4/5 round 2) ──────────────

export interface MailboxUsageInfo {
  readonly limit: number;
  readonly current: number;
  readonly remaining: number;
  readonly source: 'plan' | 'client_override';
}

export function useMailboxUsage(clientId?: string) {
  return useQuery({
    queryKey: ['mailbox-usage', clientId],
    queryFn: () =>
      apiFetch<{ data: MailboxUsageInfo }>(
        `/api/v1/clients/${clientId}/mail/mailbox-usage`,
      ),
    enabled: !!clientId,
  });
}
