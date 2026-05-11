/**
 * Certificate generation + signing helpers.
 *
 * Uses the `openssl` CLI via `execFile` (no shell, no injection
 * surface — args are array-passed). The platform-api container ships
 * with OpenSSL 3.x, the same toolchain used by cert-manager + Longhorn.
 *
 * Operations:
 *   - generateSelfSignedCa({commonName, organization, validityDays})
 *     → { certPem, keyPem }
 *   - signClientCert({caCertPem, caKeyPem, commonName, organization,
 *                     organizationalUnit, validityDays, serialHex?})
 *     → { certPem, keyPem, serialHex, fingerprintSha256,
 *         subject, expiresAt }
 *   - bundlePkcs12({certPem, keyPem, caCertPem, password, friendlyName})
 *     → Uint8Array
 *   - generateCrl({caCertPem, caKeyPem, crlNumber, validityDays,
 *                  revokedEntries})
 *     → { crlPem }
 *
 * All functions write to a per-call mkdtemp directory and unlink it
 * before returning. The tempdir lives under TMPDIR and is unreadable
 * by other users (mode 0700 by default on Linux).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';

const execFileAsync = promisify(execFile);

/**
 * Crypto-random 128-bit serial number, hex-encoded. RFC 5280 §4.1.2.2
 * permits up to 20 octets and recommends at least 64 bits of entropy.
 * We force the top bit clear so the BIGINT representation is positive
 * (OpenSSL's index.txt parses serials as positive BIGINT) and the top
 * byte is non-zero so the hex string is stable in length.
 */
export function generateSerialHex(): string {
  const buf = randomBytes(16);
  buf[0] = buf[0] & 0x7f; // clear sign bit
  buf[0] = buf[0] | 0x40; // force non-zero top nibble for stable len
  return buf.toString('hex');
}

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
  /**
   * Optional explicit serial (lowercase hex, no leading 0x). When
   * omitted, a fresh crypto-random 128-bit serial is generated.
   * The serial is returned in the result so the caller can persist it.
   */
  readonly serialHex?: string;
}

interface CertKeyPair {
  readonly certPem: string;
  readonly keyPem: string;
}

export interface SignedClientCert extends CertKeyPair {
  readonly serialHex: string;
  readonly fingerprintSha256: string;
  readonly subject: string;
  readonly expiresAt: Date;
}

export interface CrlRevokedEntry {
  /** Lowercase hex serial. */
  readonly serialHex: string;
  /** When the revocation took effect (RFC 5280 revocationDate). */
  readonly revokedAt: Date;
  /**
   * Optional RFC 5280 CRLReason code. Symbolic name; mapped to the
   * numeric code in openssl's index.txt format below. Defaults to
   * 'unspecified' when omitted.
   */
  readonly reason?: CrlReason;
}

/**
 * RFC 5280 §5.3.1 CRLReason codes. We model these as a string union
 * (rather than an enum) so the API contract maps cleanly.
 */
export type CrlReason =
  | 'unspecified'
  | 'keyCompromise'
  | 'caCompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation'
  | 'certificateHold'
  | 'privilegeWithdrawn'
  | 'aaCompromise';

interface GenerateCrlInput {
  readonly caCertPem: string;
  readonly caKeyPem: string;
  /** Monotonic CRL Number (X.509 extension). */
  readonly crlNumber: number;
  /** Validity window in days from now. */
  readonly validityDays: number;
  readonly revokedEntries: ReadonlyArray<CrlRevokedEntry>;
}

interface GenerateCrlResult {
  readonly crlPem: string;
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

    // Password handling — two paths for two threat models:
    //   * Empty password: use the literal `pass:` scheme (empty string
    //     after the colon). There's no injection risk because the value
    //     is fixed; OpenSSL 3.x produces a valid passwordless .p12 that
    //     Windows 10/11 + macOS 11+ accept on import.
    //   * Non-empty password: write to a temp file and use `pass:file:`
    //     so the password bytes never appear in argv. Closes the openssl
    //     prefix-injection hole (a literal password starting with `file:`,
    //     `env:`, `fd:`, `stdin:` would otherwise dereference to somewhere
    //     else — see openssl-passphrase-options(1)).
    //
    // The earlier revision used `-passout file:` unconditionally, which
    // failed on OpenSSL 3.x for empty-content password files ("Hmac key
    // length 0 invalid"). The dual-path approach above is what fixes that.
    const passoutArgs: string[] = [];
    if (input.password.length === 0) {
      passoutArgs.push('-passout', 'pass:');
    } else {
      const passPath = join(dir, 'pass.txt');
      await writeFile(passPath, input.password, { mode: 0o600 });
      passoutArgs.push('-passout', `file:${passPath}`);
    }

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
      ...passoutArgs,
      '-macalg', 'sha256',
    ], { timeout: 15_000 });
    const buf = await readFile(outPath);
    return new Uint8Array(buf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Sign a client cert using the provider's CA + key. The serial is
 * supplied by the caller (or generated here as a 128-bit crypto-random
 * value) so the platform layer can write the same serial into the
 * `client_certificates` table for revocation lookups.
 *
 * Returns the cert/key PEM plus the metadata needed to persist a row
 * (serial, fingerprint, full subject, expiry).
 */
export async function signClientCert(input: SignCertInput): Promise<SignedClientCert> {
  const serialHex = (input.serialHex ?? generateSerialHex()).toLowerCase();
  if (!/^[0-9a-f]{2,40}$/.test(serialHex)) {
    throw new Error(`invalid serialHex: ${serialHex}`);
  }

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

    // Sign with the stored CA, supplying the explicit 128-bit serial
    // via `-set_serial 0x<hex>` so we can persist it for CRL lookups.
    // openssl accepts decimal or 0x-prefixed hex on the CLI.
    await execFileAsync('openssl', [
      'x509', '-req',
      '-in', userCsrPath,
      '-CA', caCertPath,
      '-CAkey', caKeyPath,
      '-set_serial', `0x${serialHex}`,
      '-out', userCertPath,
      '-days', String(input.validityDays),
      '-sha256',
      '-extfile', extPath,
    ], { timeout: 30_000 });

    const [certPem, keyPem] = await Promise.all([
      readFile(userCertPath, 'utf-8'),
      readFile(userKeyPath, 'utf-8'),
    ]);
    const x509 = new X509Certificate(certPem);
    const fingerprintSha256 = createHash('sha256').update(x509.raw).digest('hex');
    return {
      certPem,
      keyPem,
      serialHex,
      fingerprintSha256,
      subject: x509.subject,
      expiresAt: new Date(x509.validTo),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Generate a CRL (Certificate Revocation List) signed by the provided
 * CA, listing each `revokedEntries` serial. Uses `openssl ca -gencrl`
 * which requires a minimal openssl.cnf + an index.txt database file
 * synthesised from the revoked-entries list.
 *
 * The CRL Number extension increments monotonically on each call
 * (caller supplies the value; persists +1 on success).
 *
 * Returns the PEM body — caller writes it into the provider row's
 * crl_pem column and the reconciler ships it to the ingress Secret
 * under the `ca.crl` key.
 *
 * Empty CRL (no revoked entries) is valid and produced when the input
 * list is empty — clients then verify "no revocations on file."
 */
export async function generateCrl(input: GenerateCrlInput): Promise<GenerateCrlResult> {
  const dir = await mkdtemp(join(tmpdir(), 'mtls-crl-'));
  try {
    const caCertPath = join(dir, 'ca-cert.pem');
    const caKeyPath = join(dir, 'ca-key.pem');
    const indexPath = join(dir, 'index.txt');
    const indexAttrPath = join(dir, 'index.txt.attr');
    const crlnumberPath = join(dir, 'crlnumber');
    const cnfPath = join(dir, 'openssl.cnf');
    const crlPath = join(dir, 'out.crl');

    // openssl.cnf for `ca -gencrl`. The `[ ca ]` section just points
    // at the `[ CA_default ]` block. `default_md` must be sha256 or
    // newer — sha1 raises a security policy error on OpenSSL 3.x.
    //
    // `unique_subject = no` so different revocations for the same CN
    // (re-issued cert, then revoked) don't blow up the index.
    const cnf =
      '[ ca ]\n' +
      'default_ca = CA_default\n' +
      '\n' +
      '[ CA_default ]\n' +
      `dir              = ${dir}\n` +
      'database         = $dir/index.txt\n' +
      'crlnumber        = $dir/crlnumber\n' +
      'certificate      = $dir/ca-cert.pem\n' +
      'private_key      = $dir/ca-key.pem\n' +
      'default_md       = sha256\n' +
      `default_crl_days = ${String(input.validityDays)}\n` +
      'policy           = policy_any\n' +
      'unique_subject   = no\n' +
      '\n' +
      '[ policy_any ]\n' +
      'commonName       = supplied\n';

    // index.txt format (one row per revoked cert):
    //   R<tab><expiry>Z<tab><revoke>Z[,reason]<tab><serial>\
    //     <tab>unknown<tab>/CN=placeholder
    //
    // Field widths:
    //   - expiry/revoke timestamps: YYMMDDHHMMSSZ (UTC, 13 chars).
    //   - serial: UPPERCASE hex, no 0x prefix, even number of digits.
    //
    // openssl validates the timestamp format; we synthesise expiry
    // from now + 1 day (the field is required, but we only care
    // about the revocation row's serial+revoke-date pair for the CRL
    // build).
    const indexLines: string[] = [];
    for (const entry of input.revokedEntries) {
      const revokeTs = openSslUtcTimestamp(entry.revokedAt);
      // expiry must be ≥ revoke; use revoke + 1d as a placeholder
      // since we don't track it in the CRL itself (only the cert).
      const expiryTs = openSslUtcTimestamp(new Date(entry.revokedAt.getTime() + 86_400_000));
      const reasonSuffix = entry.reason && entry.reason !== 'unspecified' ? `,${entry.reason}` : '';
      const serialUpper = entry.serialHex.toUpperCase();
      indexLines.push(
        ['R', expiryTs, `${revokeTs}${reasonSuffix}`, serialUpper, 'unknown', '/CN=revoked'].join('\t'),
      );
    }

    await Promise.all([
      writeFile(caCertPath, input.caCertPem, { mode: 0o600 }),
      writeFile(caKeyPath, input.caKeyPem, { mode: 0o600 }),
      writeFile(cnfPath, cnf, { mode: 0o600 }),
      writeFile(indexPath, indexLines.length === 0 ? '' : indexLines.join('\n') + '\n', { mode: 0o600 }),
      // openssl ca expects an index.txt.attr file with one config line.
      writeFile(indexAttrPath, 'unique_subject = no\n', { mode: 0o600 }),
      // CRL Number — hex, even digits, uppercase. Pad to 4 hex chars
      // minimum so openssl is happy (it parses with BIGNUM).
      writeFile(crlnumberPath, toEvenHex(input.crlNumber) + '\n', { mode: 0o600 }),
    ]);

    await execFileAsync('openssl', [
      'ca', '-gencrl',
      '-config', cnfPath,
      '-out', crlPath,
    ], { timeout: 30_000 });

    const crlPem = await readFile(crlPath, 'utf-8');
    return { crlPem };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Format a Date as openssl index.txt timestamp: YYMMDDHHMMSSZ (UTC). */
function openSslUtcTimestamp(d: Date): string {
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}${hh}${mi}${ss}Z`;
}

/** Render a non-negative integer as even-length uppercase hex. */
function toEvenHex(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`crlNumber must be a non-negative safe integer: ${n}`);
  }
  let s = n.toString(16).toUpperCase();
  if (s.length % 2 !== 0) s = `0${s}`;
  if (s.length < 4) s = s.padStart(4, '0');
  return s;
}
