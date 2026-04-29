/**
 * Certificate generation + signing helpers.
 *
 * Uses the `openssl` CLI via `execFile` (no shell, no injection
 * surface — args are array-passed). The platform-api container ships
 * with OpenSSL 3.x, the same toolchain used by cert-manager + Longhorn.
 *
 * Two operations:
 *   - generateSelfSignedCa({commonName, organization, validityDays})
 *     → { certPem, keyPem }
 *   - signClientCert({caCertPem, caKeyPem, commonName, organization,
 *                     organizationalUnit, validityDays})
 *     → { certPem, keyPem }
 *
 * Both functions write to a per-call mkdtemp directory and unlink it
 * before returning. The tempdir lives under TMPDIR and is unreadable
 * by other users (mode 0700 by default on Linux).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface GenerateCaInput {
  readonly commonName: string;
  readonly organization?: string;
  readonly validityDays: number;
}

interface SignCertInput {
  readonly caCertPem: string;
  readonly caKeyPem: string;
  readonly commonName: string;
  readonly organization?: string;
  readonly organizationalUnit?: string;
  readonly validityDays: number;
}

interface CertKeyPair {
  readonly certPem: string;
  readonly keyPem: string;
}

interface BundlePkcs12Input {
  readonly certPem: string;
  readonly keyPem: string;
  readonly caCertPem: string;
  readonly password: string;
  readonly friendlyName: string;
}

function buildSubject(opts: { commonName: string; organization?: string; organizationalUnit?: string }): string {
  const parts: string[] = [];
  if (opts.organization) parts.push(`O=${opts.organization.replace(/\//g, '\\/')}`);
  if (opts.organizationalUnit) parts.push(`OU=${opts.organizationalUnit.replace(/\//g, '\\/')}`);
  parts.push(`CN=${opts.commonName.replace(/\//g, '\\/')}`);
  return `/${parts.join('/')}`;
}

export async function generateSelfSignedCa(input: GenerateCaInput): Promise<CertKeyPair> {
  const dir = await mkdtemp(join(tmpdir(), 'mtls-ca-gen-'));
  try {
    const keyPath = join(dir, 'ca-key.pem');
    const certPath = join(dir, 'ca-cert.pem');
    const subject = buildSubject({ commonName: input.commonName, organization: input.organization });
    await execFileAsync('openssl', [
      'req', '-x509', '-new',
      '-newkey', 'rsa:4096',
      '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', String(input.validityDays),
      '-subj', subject,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,digitalSignature,cRLSign,keyCertSign',
    ], { timeout: 30_000 });
    const [keyPem, certPem] = await Promise.all([
      readFile(keyPath, 'utf-8'),
      readFile(certPath, 'utf-8'),
    ]);
    return { keyPem, certPem };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Bundle a cert+key+ca into a PKCS#12 (.p12) file. Windows + macOS
 * keychain + most browsers expect this format for client-cert import.
 *
 * The password is mandatory — Windows refuses to import a .p12 with
 * an empty password, and a passwordless .p12 leaks the private key
 * if the file is intercepted in transit.
 *
 * Returns raw bytes (caller base64-encodes for JSON transport).
 */
export async function bundlePkcs12(input: BundlePkcs12Input): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'mtls-p12-'));
  try {
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    const caPath = join(dir, 'ca.pem');
    const outPath = join(dir, 'bundle.p12');
    await Promise.all([
      writeFile(certPath, input.certPem, { mode: 0o600 }),
      writeFile(keyPath, input.keyPem, { mode: 0o600 }),
      writeFile(caPath, input.caCertPem, { mode: 0o600 }),
    ]);
    // -macalg sha256 + -keypbe AES-256-CBC + -certpbe AES-256-CBC use
    // modern algorithms; legacy compat (Windows 7) would need
    // -legacy. Default Windows 10/11 + macOS 11+ accept these fine.
    await execFileAsync('openssl', [
      'pkcs12', '-export',
      '-in', certPath,
      '-inkey', keyPath,
      '-certfile', caPath,
      '-out', outPath,
      '-name', input.friendlyName,
      '-passout', `pass:${input.password}`,
      '-macalg', 'sha256',
    ], { timeout: 15_000 });
    const buf = await readFile(outPath);
    return new Uint8Array(buf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function signClientCert(input: SignCertInput): Promise<CertKeyPair> {
  const dir = await mkdtemp(join(tmpdir(), 'mtls-sign-'));
  try {
    const caKeyPath = join(dir, 'ca-key.pem');
    const caCertPath = join(dir, 'ca-cert.pem');
    const userKeyPath = join(dir, 'user-key.pem');
    const userCsrPath = join(dir, 'user.csr');
    const userCertPath = join(dir, 'user-cert.pem');
    const extPath = join(dir, 'ext.cnf');

    // Materialise CA cert + key for openssl x509 -CA.
    await Promise.all([
      writeFile(caCertPath, input.caCertPem, { mode: 0o600 }),
      writeFile(caKeyPath, input.caKeyPem, { mode: 0o600 }),
    ]);

    // Build a CSR for the new user cert.
    const subject = buildSubject({
      commonName: input.commonName,
      organization: input.organization,
      organizationalUnit: input.organizationalUnit,
    });
    await execFileAsync('openssl', [
      'req', '-new',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', userKeyPath,
      '-out', userCsrPath,
      '-subj', subject,
    ], { timeout: 30_000 });

    // Extension file: client-auth EKU + non-CA basic constraints.
    await writeFile(extPath,
      'basicConstraints=critical,CA:FALSE\n' +
      'keyUsage=critical,digitalSignature,keyEncipherment\n' +
      'extendedKeyUsage=clientAuth\n',
      { mode: 0o600 },
    );

    // Sign with the stored CA. -CAcreateserial creates a fresh serial
    // file in the tempdir on each call (fine — we never reuse it).
    await execFileAsync('openssl', [
      'x509', '-req',
      '-in', userCsrPath,
      '-CA', caCertPath,
      '-CAkey', caKeyPath,
      '-CAcreateserial',
      '-out', userCertPath,
      '-days', String(input.validityDays),
      '-sha256',
      '-extfile', extPath,
    ], { timeout: 30_000 });

    const [certPem, keyPem] = await Promise.all([
      readFile(userCertPath, 'utf-8'),
      readFile(userKeyPath, 'utf-8'),
    ]);
    return { certPem, keyPem };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
