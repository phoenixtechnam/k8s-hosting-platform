import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { TestConnectionResult } from './service.js';

export interface S3ProbeInput {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

// How long we wait for S3 before declaring the probe a failure. Operators
// see this in the UI's "test connection" latency, so keep it short enough
// to be a useful signal (not a 60s hang) but long enough for a healthy
// round-trip over VPN + provider-side gateway.
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Runs an S3 HeadBucketCommand against the given endpoint + credentials.
 * Returns TestConnectionResult with a classified error code so the UI
 * and admin-panel logs can distinguish "we can't reach the server",
 * "the keys are wrong", "the key is fine but this bucket doesn't exist",
 * and "the key is fine but lacks ListBucket / HeadBucket permission".
 *
 * HeadBucket requires s3:ListBucket permission against the target bucket;
 * Longhorn's own backup write path needs s3:PutObject + s3:GetObject +
 * s3:DeleteObject as well, so a passing HeadBucket does NOT guarantee a
 * successful backup. A follow-up "write-test" button can be added in
 * Phase B4 to close that gap.
 */
export async function probeS3(input: S3ProbeInput): Promise<TestConnectionResult> {
  const started = Date.now();
  const client = new S3Client({
    region: input.region,
    endpoint: input.endpoint,
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
    // Path-style is required by most S3-compatible providers (MinIO,
    // Hetzner Object Storage, Backblaze, Wasabi). AWS itself accepts it
    // and will only warn; there's no correctness cost to path-style.
    forcePathStyle: true,
    // Tight-ish connection budget. AWS SDK's default is 2 retries; we
    // disable retries so a Test Connection button returns quickly
    // instead of amplifying a temporary-looking failure.
    maxAttempts: 1,
  });

  try {
    await withTimeout(
      client.send(new HeadBucketCommand({ Bucket: input.bucket })),
      PROBE_TIMEOUT_MS,
    );
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const { code, message } = classifyError(err);
    return { ok: false, latencyMs, error: { code, message } };
  } finally {
    // Free up sockets. S3Client holds a Keep-Alive pool which otherwise
    // prevents Vitest from exiting on test completion. Guarded because
    // the test suite's fake client doesn't implement destroy.
    if (typeof (client as { destroy?: unknown }).destroy === 'function') {
      (client as { destroy: () => void }).destroy();
    }
  }
}

interface AwsLikeError {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function classifyError(err: unknown): { code: string; message: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as AwsLikeError;
  const name = e.name ?? '';
  const code = e.code ?? '';
  const status = e.$metadata?.httpStatusCode ?? 0;
  const message = e.message ?? (typeof err === 'string' ? err : 'Unknown error');

  // Auth errors take priority over generic 403s — a wrong access key ID
  // or signature mismatch is actionable ("check your keys") vs an IAM
  // policy gap ("ask the provider for ListBucket").
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return { code: 'AUTH_FAILED', message };
  }
  if (name === 'NoSuchBucket' || status === 404) {
    return { code: 'NOT_FOUND', message };
  }
  if (status === 403 || name === 'AccessDenied' || name === 'Forbidden') {
    return { code: 'PERMISSION_DENIED', message };
  }
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') {
    return { code: 'TIMEOUT', message };
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENETUNREACH') {
    return { code: 'NETWORK_ERROR', message };
  }
  return { code: 'S3_ERROR', message };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  // AbortController on the S3 request would be better, but the SDK's
  // per-request abort plumbing is awkward to thread through the
  // HeadBucketCommand constructor. A race is sufficient for the probe
  // use case — we're only trying to bound worst-case latency on the UI
  // Test Connection button.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject({ name: 'TimeoutError', message: `Probe exceeded ${ms}ms` }),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
