import { describe, it, expect, vi } from 'vitest';
import { uploadCert, getCert, deleteCert } from './service.js';
import { ApiError } from '../../shared/errors.js';

// Mock the crypto module for encryption
vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue('encrypted-private-key'),
}));

type Db = Parameters<typeof uploadCert>[0];

// A minimal self-signed PEM certificate for testing
// Generated via: openssl req -x509 -newkey rsa:512 -nodes -days 3650
// We use crypto.X509Certificate to parse it, so we need a real one.
// Instead, we'll mock the crypto module for X509Certificate.
const VALID_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDU+pQEkpJsLDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjUwMTAxMDAwMDAwWhcNMzUwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7
7PFVxRjRYCqH3aKCYAE8BH1dNiMgCEzsa0VFZe2M4k/9Gnkw7yyzIkUSOH84BXou
8mxWikJdW7YhOSSHSKEHTb7MgKpGStukOy2f5ITUb7QGXMF2Qe2PCXQ2dS1SNQJ
ayb7JYE4aO/TRDCn3SMU0NN5g4DdGhzOiIp0F2J3p1EGh3AVEXsP3MBiKx0p/Vty
VRNQJ4s3qbOHGJHD1kW9aGSEFzF3V4OPkiU5ux2c1VHsMeqpkMQD9D7p0WnkJEr
FbNPQ3ZmaSEIMXJBmeh5aCZ6URQrgGlqfJP9hV9qoB2b6fh0qtjBJIY4PhfPHAaJ
F63sSC/VaVPJ2R0kGB/VAgMBAAEwDQYJKoZIhvcNAQELBQADggEBADnKTOBEM7ug
RIti+2GC2h6bswPAdNBjmPCAupeHPviRP0dtDT9WCE33YIMfFywJSmjSE8uIBKZM
HPXLHLFjG3aK5G/7b2Mn6t62gy6Pw0wIqNjL1/XGAQMEVlX8jFe/xIfh9e5QLjCp
AK5LKZzZBWM7+QwR6YeGM0mXAiwSgSn0DmHkH3B3ey0B60C3xe3QxGKqEcMBzs/
aQHaBV0I4gCHsGRPh3AEsEtiDv+t4YGxwGE+AVpDALN8iG+K2Wj9ut0tpWdJOAPe
PJdKsw0D4/6TNM3JQJVfyQM1f7R5y0Xdff6oBv1CP9qhgBxdNmhF6Yg1GQZL5eN
l14MH9EI+4M=
-----END CERTIFICATE-----`;

const VALID_PEM_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7fakecontent==
-----END PRIVATE KEY-----`;

const encryptionKey = '0'.repeat(64);

// We need to mock X509Certificate since the test cert above won't actually parse
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    default: {
      ...actual,
      X509Certificate: class MockX509Certificate {
        issuer = 'CN=localhost';
        subject = 'CN=localhost';
        validTo = '2035-01-01T00:00:00.000Z';
        constructor(_pem: string) {
          // Mock parsing
        }
      },
      randomUUID: actual.randomUUID,
      randomBytes: actual.randomBytes,
      createCipheriv: actual.createCipheriv,
      createDecipheriv: actual.createDecipheriv,
    },
    X509Certificate: class MockX509Certificate {
      issuer = 'CN=localhost';
      subject = 'CN=localhost';
      validTo = '2035-01-01T00:00:00.000Z';
      constructor(_pem: string) {
        // Mock parsing
      }
    },
  };
});

function createMockDb(options: {
  domainResult?: unknown[];
  certResult?: unknown[];
  certResults?: unknown[][];
} = {}) {
  const { domainResult = [{ id: 'd1', clientId: 'c1', domainName: 'example.com' }] } = options;
  const certResults = options.certResults ?? [options.certResult ?? []];

  let selectCallIndex = 0;

  const whereFn = vi.fn().mockImplementation(() => {
    const idx = selectCallIndex++;
    // First call = domain lookup, subsequent = cert lookups
    if (idx === 0) return Promise.resolve(domainResult);
    const certIdx = Math.min(idx - 1, certResults.length - 1);
    return Promise.resolve(certResults[certIdx]);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    _mocks: { selectFn, insertFn, deleteFn, whereFn, insertValues, deleteWhere },
  } as unknown as Db & { _mocks: Record<string, ReturnType<typeof vi.fn>> };
}

describe('uploadCert', () => {
  it('should throw DOMAIN_NOT_FOUND when domain does not exist', async () => {
    const db = createMockDb({ domainResult: [] });

    await expect(
      uploadCert(db, 'c1', 'd-missing', {
        certificate: VALID_PEM_CERT,
        private_key: VALID_PEM_KEY,
      }, encryptionKey),
    ).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });

  it('should throw INVALID_CERTIFICATE when cert is not PEM', async () => {
    const db = createMockDb();

    await expect(
      uploadCert(db, 'c1', 'd1', {
        certificate: 'not-a-pem-cert',
        private_key: VALID_PEM_KEY,
      }, encryptionKey),
    ).rejects.toMatchObject({
      code: 'INVALID_CERTIFICATE',
      status: 400,
    });
  });

  it('should insert cert and return sanitized result (no private key)', async () => {
    const certRow = {
      id: 'cert-1',
      domainId: 'd1',
      clientId: 'c1',
      certificate: VALID_PEM_CERT,
      privateKeyEncrypted: 'encrypted-private-key',
      caBundle: null,
      issuer: 'CN=localhost',
      subject: 'CN=localhost',
      expiresAt: new Date('2035-01-01'),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // domain lookup → success, existing cert → none, created cert → certRow
    const db = createMockDb({
      certResults: [[], [certRow]],
    });

    const result = await uploadCert(db, 'c1', 'd1', {
      certificate: VALID_PEM_CERT,
      private_key: VALID_PEM_KEY,
    }, encryptionKey);

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('domainId', 'd1');
    expect(result).toHaveProperty('issuer');
    expect(result).not.toHaveProperty('privateKeyEncrypted');
    expect(result).not.toHaveProperty('certificate');
    expect(db._mocks.insertFn).toHaveBeenCalled();
  });
});

describe('getCert', () => {
  it('should throw SSL_CERT_NOT_FOUND when no cert exists', async () => {
    // For getCert, the first select call is the cert lookup
    let callIdx = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callIdx++;
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Db;

    await expect(getCert(db, 'c1', 'd1')).rejects.toMatchObject({
      code: 'SSL_CERT_NOT_FOUND',
      status: 404,
    });
  });

  it('should return cert metadata without private key', async () => {
    const certRow = {
      id: 'cert-1',
      domainId: 'd1',
      clientId: 'c1',
      certificate: VALID_PEM_CERT,
      privateKeyEncrypted: 'encrypted',
      caBundle: null,
      issuer: 'CN=localhost',
      subject: 'CN=localhost',
      expiresAt: new Date('2035-01-01'),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const whereFn = vi.fn().mockResolvedValue([certRow]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Db;

    const result = await getCert(db, 'c1', 'd1');

    expect(result).toHaveProperty('id', 'cert-1');
    expect(result).toHaveProperty('issuer', 'CN=localhost');
    expect(result).not.toHaveProperty('privateKeyEncrypted');
    expect(result).not.toHaveProperty('certificate');
  });
});

describe('deleteCert', () => {
  it('should throw SSL_CERT_NOT_FOUND when no cert exists', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Db;

    await expect(deleteCert(db, 'c1', 'd1')).rejects.toMatchObject({
      code: 'SSL_CERT_NOT_FOUND',
      status: 404,
    });
  });

  it('should delete cert when it exists', async () => {
    const whereFn = vi.fn().mockResolvedValue([{ id: 'cert-1' }]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const db = { select: selectFn, delete: deleteFn } as unknown as Db;

    await deleteCert(db, 'c1', 'd1');
    expect(deleteFn).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
  });
});
