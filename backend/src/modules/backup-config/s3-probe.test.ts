import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the AWS SDK before importing the module under test ────────────
//
// HeadBucketCommand is a class we'll match by name from the test's
// perspective. S3Client.send is mocked to either resolve (HTTP 200) or
// reject with a well-known error shape so probeS3 can classify it.

const sendMock = vi.fn();
class FakeS3Client {
  constructor(public readonly config: Record<string, unknown>) {}
  send = sendMock;
}
class FakeHeadBucketCommand {
  constructor(public readonly input: { Bucket: string }) {}
}

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: FakeS3Client,
  HeadBucketCommand: FakeHeadBucketCommand,
}));

const { probeS3 } = await import('./s3-probe.js');

const VALID_INPUT = {
  endpoint: 'https://fsn1.example.com',
  region: 'eu-central',
  accessKeyId: 'AKIAXXXXXXXXXXXXXXX',
  secretAccessKey: 'S'.repeat(40),
  bucket: 'k8s-staging',
};

describe('probeS3', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns ok + latencyMs on successful HeadBucket', async () => {
    sendMock.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(sendMock).toHaveBeenCalledOnce();
    // HeadBucketCommand should carry the bucket name
    const [cmd] = sendMock.mock.calls[0];
    expect(cmd.input.Bucket).toBe('k8s-staging');
  });

  it('classifies 403 as PERMISSION_DENIED (keys valid, no s3:ListBucket)', async () => {
    sendMock.mockRejectedValue({
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
      message: 'Access Denied',
    });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PERMISSION_DENIED');
  });

  it('classifies 403 InvalidAccessKeyId as AUTH_FAILED', async () => {
    sendMock.mockRejectedValue({
      name: 'InvalidAccessKeyId',
      $metadata: { httpStatusCode: 403 },
      message: 'The AWS Access Key Id you provided does not exist in our records.',
    });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUTH_FAILED');
  });

  it('classifies SignatureDoesNotMatch as AUTH_FAILED', async () => {
    sendMock.mockRejectedValue({
      name: 'SignatureDoesNotMatch',
      $metadata: { httpStatusCode: 403 },
    });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUTH_FAILED');
  });

  it('classifies 404 NoSuchBucket as NOT_FOUND', async () => {
    sendMock.mockRejectedValue({
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('classifies AbortError / TimeoutError as TIMEOUT', async () => {
    sendMock.mockRejectedValue({
      name: 'TimeoutError',
      message: 'Connection timed out after 5000ms',
    });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
  });

  it('classifies ENOTFOUND / ECONNREFUSED as NETWORK_ERROR', async () => {
    sendMock.mockRejectedValue({
      name: 'Error',
      code: 'ENOTFOUND',
      message: 'getaddrinfo ENOTFOUND fsn1.example.com',
    });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
  });

  it('falls back to S3_ERROR for unknown failures', async () => {
    sendMock.mockRejectedValue({ name: 'WeirdError', message: 'something else' });
    const result = await probeS3(VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('S3_ERROR');
  });

});
