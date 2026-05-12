import { useState } from 'react';
import {
  Database,
  AlertTriangle,
  Loader2,
  Info,
  X,
  Check,
} from 'lucide-react';
import {
  useBlobStore,
  useUpdateBlobStore,
  useBlobStoreJobStatus,
} from '@/hooks/use-stalwart-blob-store';
import type { BlobStoreType } from '@k8s-hosting/api-contracts';

/**
 * Email Management → Stalwart Blob Storage card.
 *
 * Lets a super_admin switch the Stalwart 0.16 BlobStore singleton
 * between three operator-meaningful backends:
 *
 *   - Default: stored in the configured DataStore (mail-pg PG by
 *     default). The shipped default. Blows up at scale because PG
 *     row sizes get unwieldy.
 *   - S3: external S3-compatible bucket. Required for HA stateless
 *     because each replica's emptyDir would split blobs otherwise.
 *   - FileSystem: per-replica local disk. INCOMPATIBLE with multi-
 *     replica Stalwart — each replica only sees its own blobs.
 *
 * Switching is online but DOES NOT migrate existing blobs. New mail
 * lands in the new store; old mail may be unreachable. The confirm
 * modal forces the operator to type MIGRATE to acknowledge this.
 *
 * Backend spawns a one-shot Job (`stalwart-blob-store-update-<id>`)
 * that runs the cli update + self-verifies the new type took. This
 * card polls the Job until terminal and surfaces the cli BEFORE/
 * AFTER output via `podLogTail`.
 */
export default function StalwartBlobStoreCard() {
  const store = useBlobStore();
  const update = useUpdateBlobStore();
  const [pendingJobName, setPendingJobName] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState<DraftSelection>({ type: 'Default' });
  const job = useBlobStoreJobStatus(pendingJobName);

  if (store.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading blob storage…
        </div>
      </div>
    );
  }
  if (store.isError || !store.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read Stalwart BlobStore.{' '}
            {store.error instanceof Error ? store.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const current = store.data.data;
  const draftDiffers = draft.type !== current.type
    || (draft.type === 'S3' && draft.s3?.bucket !== current.s3?.bucket)
    || (draft.type === 'CIFS' && (draft.cifs?.host !== current.cifs?.host || draft.cifs?.share !== current.cifs?.share));

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Database size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="blob-store-heading">
          Stalwart Blob Storage
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Where Stalwart writes message bodies. Switch is{' '}
        <strong>online</strong> but{' '}
        <strong className="text-amber-700 dark:text-amber-300">does NOT migrate existing blobs</strong>{' '}
        — old mail stays in the previous store and may become unreachable until
        you run an external migrator.
      </p>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 text-sm">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Current backend
        </div>
        <div data-testid="blob-store-current-type" className="font-mono text-base text-gray-900 dark:text-gray-100 mt-1">
          {current.type}
          {current.type === 'S3' && current.s3?.bucket
            ? ` — s3://${current.s3.bucket}${current.s3.region ? ` (${current.s3.region})` : ''}`
            : null}
          {current.type === 'FileSystem' && current.fileSystem?.path
            ? ` — ${current.fileSystem.path}`
            : null}
          {current.type === 'CIFS' && current.cifs?.host
            ? ` — //${current.cifs.host}/${current.cifs.share}${current.cifs.path ?? ''}`
            : null}
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Switch to
        </div>

        <RadioOption
          label="Default (mail-pg / PostgreSQL)"
          description="Single-tenant default. Works without external infra. Blobs stored in the mail-pg database — blows up on disk at scale (>~5 GiB)."
          value="Default"
          checked={draft.type === 'Default'}
          onChange={() => setDraft({ type: 'Default' })}
          testId="blob-store-radio-default"
        />
        <RadioOption
          label="S3 — external S3-compatible bucket"
          description="Required for HA stateless multi-replica Stalwart. Operator provides bucket + credentials."
          value="S3"
          checked={draft.type === 'S3'}
          onChange={() => setDraft({ type: 'S3', s3: { bucket: '', region: '', endpoint: '', accessKey: '', secretKey: '' } })}
          testId="blob-store-radio-s3"
        />
        <RadioOption
          label="FileSystem — per-replica local disk"
          description="INCOMPATIBLE with multi-replica Stalwart (each replica sees only its own blobs). Single-replica only."
          value="FileSystem"
          checked={draft.type === 'FileSystem'}
          onChange={() => setDraft({ type: 'FileSystem', fileSystem: { path: '/var/lib/stalwart/blobs', depth: 2 } })}
          testId="blob-store-radio-filesystem"
        />
        <RadioOption
          label="CIFS — SMB/CIFS network share"
          description="Blobs on a CIFS/SMB network share (e.g. Hetzner Storage Box). Stalwart pins to the node where the share is mounted. Requires node-selector mode: required."
          value="CIFS"
          checked={draft.type === 'CIFS'}
          onChange={() => setDraft({
            type: 'CIFS',
            cifs: { host: '', share: '', path: '/stalwart/blobs', depth: 2, username: '', password: '' },
          })}
          testId="blob-store-radio-cifs"
        />

        {draft.type === 'CIFS' ? (
          <div className="ml-7 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            CIFS requires Stalwart to be pinned to the node where the share is mounted.
            Set <strong>Node Placement → mode: required</strong> on the same node after applying.
          </div>
        ) : null}

        {draft.type === 'S3' ? (
          <S3FormFields draft={draft} onChange={(s3) => setDraft({ type: 'S3', s3 })} />
        ) : null}
        {draft.type === 'FileSystem' ? (
          <FileSystemFormFields
            draft={draft}
            onChange={(fileSystem) => setDraft({ type: 'FileSystem', fileSystem })}
          />
        ) : null}
        {draft.type === 'CIFS' ? (
          <CIFSFormFields
            draft={draft}
            onChange={(cifs) => setDraft({ type: 'CIFS', cifs })}
          />
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!draftDiffers || !isDraftComplete(draft) || update.isPending}
            data-testid="blob-store-apply"
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500 bg-amber-500 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
            {update.isPending ? 'Submitting…' : 'Apply backend switch'}
          </button>
          {draftDiffers ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Will change from <code>{current.type}</code> to <code>{draft.type}</code>.
            </p>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              No change — pick a different backend or modify config.
            </p>
          )}
        </div>
      </div>

      {pendingJobName && job.data ? (
        <JobStatusPanel
          status={job.data.data}
          onClose={() => {
            if (job.data?.data.status === 'succeeded' || job.data?.data.status === 'failed') {
              setPendingJobName(null);
            }
          }}
        />
      ) : null}

      {update.isError ? (
        <div role="alert" data-testid="blob-store-error" className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {update.error instanceof Error ? update.error.message : 'Update failed — see server logs.'}
          </span>
        </div>
      ) : null}

      {confirmOpen ? (
        <BlobStoreConfirmModal
          fromType={current.type}
          toType={draft.type}
          pending={update.isPending}
          error={update.error}
          onClose={() => {
            if (!update.isPending) {
              setConfirmOpen(false);
              update.reset();
            }
          }}
          onConfirm={async () => {
            try {
              const result = await update.mutateAsync(draftToRequest(draft));
              setPendingJobName(result.data.jobName);
              setConfirmOpen(false);
              update.reset();
              // Clear S3 secrets from React state immediately on
              // success — the cleartext should not survive past the
              // request that needed it. Reset to Default so the
              // discriminated union matches without re-typing the
              // form fields.
              setDraft({ type: 'Default' });
              void result;
            } catch {
              // surfaced via update.error
            }
          }}
        />
      ) : null}
    </div>
  );
}

// ── form fields ───────────────────────────────────────────────────

interface RadioOptionProps {
  readonly label: string;
  readonly description: string;
  readonly value: BlobStoreType;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly testId: string;
}
function RadioOption({ label, description, value, checked, onChange, testId }: RadioOptionProps) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
      <input
        type="radio"
        name="blob-store-type"
        value={value}
        checked={checked}
        onChange={onChange}
        data-testid={testId}
        className="mt-1"
      />
      <div className="flex-1">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>
      </div>
    </label>
  );
}

interface DraftS3 {
  bucket: string;
  region: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
}
interface DraftFs {
  path: string;
  depth: number;
}
interface DraftCifs {
  host: string;
  share: string;
  path: string;
  depth: number;
  username: string;
  password: string;
}
type DraftSelection =
  | { type: 'Default' }
  | { type: 'S3'; s3: DraftS3 }
  | { type: 'FileSystem'; fileSystem: DraftFs }
  | { type: 'CIFS'; cifs: DraftCifs };

function isDraftComplete(draft: DraftSelection): boolean {
  if (draft.type === 'Default') return true;
  if (draft.type === 'FileSystem') return draft.fileSystem.path.length > 0;
  if (draft.type === 'CIFS') {
    return draft.cifs.host.length > 0
      && draft.cifs.share.length > 0
      && draft.cifs.username.length > 0
      && draft.cifs.password.length > 0;
  }
  // S3 — all fields required except endpoint
  return draft.s3.bucket.length > 0
    && draft.s3.region.length > 0
    && draft.s3.accessKey.length > 0
    && draft.s3.secretKey.length > 0;
}

function draftToRequest(draft: DraftSelection) {
  if (draft.type === 'Default') return { type: 'Default' as const };
  if (draft.type === 'FileSystem') {
    return {
      type: 'FileSystem' as const,
      fileSystem: { path: draft.fileSystem.path, depth: draft.fileSystem.depth },
    };
  }
  if (draft.type === 'CIFS') {
    return {
      type: 'CIFS' as const,
      cifs: {
        host: draft.cifs.host,
        share: draft.cifs.share,
        path: draft.cifs.path || '/stalwart/blobs',
        depth: draft.cifs.depth,
        username: draft.cifs.username,
        password: draft.cifs.password,
      },
    };
  }
  const s3 = {
    bucket: draft.s3.bucket,
    region: draft.s3.region,
    accessKey: draft.s3.accessKey,
    secretKey: draft.s3.secretKey,
    ...(draft.s3.endpoint ? { endpoint: draft.s3.endpoint } : {}),
  };
  return { type: 'S3' as const, s3 };
}

interface S3FormProps {
  readonly draft: { type: 'S3'; s3: DraftS3 };
  readonly onChange: (s3: DraftS3) => void;
}
function S3FormFields({ draft, onChange }: S3FormProps) {
  const [showSecret, setShowSecret] = useState(false);
  return (
    <div className="ml-7 grid grid-cols-2 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
      <Field label="Bucket *" testId="blob-store-s3-bucket">
        <input
          type="text" required
          value={draft.s3.bucket}
          onChange={(e) => onChange({ ...draft.s3, bucket: e.target.value })}
          data-testid="blob-store-s3-bucket"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Region *" testId="blob-store-s3-region">
        <input
          type="text" required
          value={draft.s3.region}
          onChange={(e) => onChange({ ...draft.s3, region: e.target.value })}
          data-testid="blob-store-s3-region"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Endpoint (optional, S3-compat servers)" testId="blob-store-s3-endpoint" cols={2}>
        <input
          type="url"
          value={draft.s3.endpoint}
          onChange={(e) => onChange({ ...draft.s3, endpoint: e.target.value })}
          placeholder="https://s3.example.com"
          data-testid="blob-store-s3-endpoint"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Access key *" testId="blob-store-s3-access">
        <input
          type="text" required autoComplete="off"
          value={draft.s3.accessKey}
          onChange={(e) => onChange({ ...draft.s3, accessKey: e.target.value })}
          data-testid="blob-store-s3-access"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Secret key * (stored in Secret, never echoed)" testId="blob-store-s3-secret">
        <div className="flex gap-2">
          <input
            type={showSecret ? 'text' : 'password'} required autoComplete="off"
            value={draft.s3.secretKey}
            onChange={(e) => onChange({ ...draft.s3, secretKey: e.target.value })}
            data-testid="blob-store-s3-secret"
            className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            data-testid="blob-store-s3-secret-toggle"
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200"
          >
            {showSecret ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>
      <p className="col-span-2 text-xs text-gray-500 dark:text-gray-400">
        Keys land in the <code>stalwart-blob-credentials</code> Secret in the{' '}
        <code>mail</code> namespace. Stalwart reads them via{' '}
        <code>envFrom</code>; they never appear in container argv or apiserver
        audit logs.
      </p>
    </div>
  );
}

interface FsFormProps {
  readonly draft: { type: 'FileSystem'; fileSystem: DraftFs };
  readonly onChange: (fs: DraftFs) => void;
}
function FileSystemFormFields({ draft, onChange }: FsFormProps) {
  return (
    <div className="ml-7 grid grid-cols-2 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
      <Field label="Path inside container" testId="blob-store-fs-path">
        <input
          type="text"
          value={draft.fileSystem.path}
          onChange={(e) => onChange({ ...draft.fileSystem, path: e.target.value })}
          data-testid="blob-store-fs-path"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Directory depth" testId="blob-store-fs-depth">
        <input
          type="number" min={0} max={8}
          value={draft.fileSystem.depth}
          onChange={(e) => onChange({ ...draft.fileSystem, depth: Number.parseInt(e.target.value, 10) || 0 })}
          data-testid="blob-store-fs-depth"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
    </div>
  );
}

interface CifsFormProps {
  readonly draft: { type: 'CIFS'; cifs: DraftCifs };
  readonly onChange: (cifs: DraftCifs) => void;
}
function CIFSFormFields({ draft, onChange }: CifsFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  return (
    <div className="ml-7 grid grid-cols-2 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
      <Field label="CIFS host *" testId="blob-store-cifs-host">
        <input
          type="text" required
          value={draft.cifs.host}
          onChange={(e) => onChange({ ...draft.cifs, host: e.target.value })}
          placeholder="fileserver.example.com"
          data-testid="blob-store-cifs-host"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Share name *" testId="blob-store-cifs-share">
        <input
          type="text" required
          value={draft.cifs.share}
          onChange={(e) => onChange({ ...draft.cifs, share: e.target.value })}
          placeholder="mail-blobs"
          data-testid="blob-store-cifs-share"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Path in share" testId="blob-store-cifs-path">
        <input
          type="text"
          value={draft.cifs.path}
          onChange={(e) => onChange({ ...draft.cifs, path: e.target.value })}
          placeholder="/stalwart/blobs"
          data-testid="blob-store-cifs-path"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Directory depth" testId="blob-store-cifs-depth">
        <input
          type="number" min={0} max={8}
          value={draft.cifs.depth}
          onChange={(e) => onChange({ ...draft.cifs, depth: Number.parseInt(e.target.value, 10) || 0 })}
          data-testid="blob-store-cifs-depth"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Username *" testId="blob-store-cifs-username">
        <input
          type="text" required autoComplete="off"
          value={draft.cifs.username}
          onChange={(e) => onChange({ ...draft.cifs, username: e.target.value })}
          data-testid="blob-store-cifs-username"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
        />
      </Field>
      <Field label="Password * (stored in Secret)" testId="blob-store-cifs-password">
        <div className="flex gap-2">
          <input
            type={showPassword ? 'text' : 'password'} required autoComplete="off"
            value={draft.cifs.password}
            onChange={(e) => onChange({ ...draft.cifs, password: e.target.value })}
            data-testid="blob-store-cifs-password"
            className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            data-testid="blob-store-cifs-password-toggle"
            className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>
      <p className="col-span-2 text-xs text-gray-500 dark:text-gray-400">
        Credentials land in the <code>stalwart-cifs-blobstore-creds</code> Secret in the{' '}
        <code>mail</code> namespace. Stalwart is configured with FileSystem BlobStore pointing
        at the CIFS hostPath mount.
      </p>
    </div>
  );
}

interface FieldProps {
  readonly label: string;
  readonly testId: string;
  readonly children: React.ReactNode;
  readonly cols?: number;
}
function Field({ label, children, cols = 1 }: FieldProps) {
  return (
    <div className={cols === 2 ? 'col-span-2' : ''}>
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

// ── confirm modal ─────────────────────────────────────────────────

interface BlobStoreConfirmModalProps {
  readonly fromType: BlobStoreType;
  readonly toType: BlobStoreType;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
}
function BlobStoreConfirmModal({
  fromType,
  toType,
  pending,
  error,
  onClose,
  onConfirm,
}: BlobStoreConfirmModalProps) {
  const [migrateText, setMigrateText] = useState('');
  const canConfirm = migrateText === 'MIGRATE' && !pending;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      data-testid="blob-store-confirm-modal"
    >
      <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/30 p-2">
            <AlertTriangle size={20} className="text-amber-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Switch BlobStore: {fromType} → {toType}?
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Stalwart applies the change in-flight via cli — no restart needed.
              However, this is a <strong>one-way switch with consequences</strong>:
            </p>
            <ul className="mt-2 ml-5 list-disc text-sm text-gray-700 dark:text-gray-300 space-y-1">
              <li>Existing blobs WILL NOT migrate.</li>
              <li>New mail lands in the new store.</li>
              <li>
                Old messages may become unreachable until you run an external
                migration tool — see{' '}
                <a
                  href="https://github.com/phoenixtechnam/k8s-hosting-platform/blob/main/docs/06-features/STALWART_BLOB_STORE_MIGRATION.md"
                  className="underline text-blue-700 dark:text-blue-300"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  migration docs
                </a>.
              </li>
              {toType === 'FileSystem' ? (
                <li className="text-red-700 dark:text-red-300">
                  <strong>FileSystem is INCOMPATIBLE with multi-replica HA.</strong>{' '}
                  Apply HA will fail until you switch back.
                </li>
              ) : null}
              {toType === 'CIFS' ? (
                <li className="text-amber-700 dark:text-amber-300">
                  <strong>CIFS requires node pinning.</strong>{' '}
                  Set Node Placement → mode: required on the CIFS-mount node after applying,
                  otherwise Stalwart may land on a node without the share.
                </li>
              ) : null}
              {toType === 'S3' ? (
                <li>
                  S3 access keys land in the <code>stalwart-blob-credentials</code> Secret
                  (mail ns). Cleartext is sent ONCE to the API and zeroed from the form
                  on submit.
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>Type <code>MIGRATE</code> below to confirm.</span>
        </div>

        <input
          type="text"
          value={migrateText}
          onChange={(e) => setMigrateText(e.target.value)}
          data-testid="blob-store-migrate-confirm"
          placeholder="MIGRATE"
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono uppercase tracking-wider text-gray-900 dark:text-gray-100"
        />

        {error ? (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error instanceof Error ? error.message : 'Switch failed — see server logs.'}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            data-testid="blob-store-confirm-cancel"
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            data-testid="blob-store-confirm-submit"
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {pending ? 'Switching…' : 'Switch backend'}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          aria-label="Close"
          className="absolute top-3 right-3 rounded-md p-1 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ── job status panel ──────────────────────────────────────────────

interface JobStatusPanelProps {
  readonly status: import('@k8s-hosting/api-contracts').BlobStoreJobStatusResponse;
  readonly onClose: () => void;
}
function JobStatusPanel({ status, onClose }: JobStatusPanelProps) {
  const isTerminal = status.status === 'succeeded' || status.status === 'failed';
  return (
    <div
      role="status"
      data-testid="blob-store-job-panel"
      className={`rounded-lg border-2 p-4 space-y-2 ${
        status.status === 'succeeded'
          ? 'border-green-300 bg-green-50 dark:bg-green-900/20'
          : status.status === 'failed'
          ? 'border-red-300 bg-red-50 dark:bg-red-900/20'
          : 'border-blue-300 bg-blue-50 dark:bg-blue-900/20'
      }`}
    >
      <div className="flex items-center gap-2">
        {status.status === 'succeeded' ? <Check size={16} className="text-green-600" /> : null}
        {status.status === 'failed' ? <AlertTriangle size={16} className="text-red-600" /> : null}
        {status.status === 'queued' || status.status === 'running' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : null}
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Blob-store update Job: <code>{status.jobName}</code>
        </h3>
        <span data-testid="blob-store-job-status" className="ml-2 rounded bg-gray-200 dark:bg-gray-800 px-2 py-0.5 text-xs">
          {status.status}
        </span>
        {isTerminal ? (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-500 hover:bg-white/50 dark:hover:bg-gray-800"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {status.failureReason ? (
        <div className="text-sm text-red-700 dark:text-red-300 font-mono">
          {status.failureReason}
        </div>
      ) : null}
      {status.podLogTail ? (
        <pre data-testid="blob-store-job-log" className="rounded bg-gray-900 text-gray-100 p-3 text-xs overflow-auto max-h-48 font-mono">
          {status.podLogTail}
        </pre>
      ) : null}
    </div>
  );
}
