import crypto from 'crypto';

export interface DkimKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export function generateDkimKeyPair(): DkimKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { privateKey, publicKey };
}

export function formatDkimDnsValue(publicKey: string): string {
  const base64 = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');

  return `v=DKIM1; k=rsa; p=${base64}`;
}
