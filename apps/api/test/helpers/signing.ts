import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/** An Ed25519 keypair generated per test run: stands in for Discord, which we cannot make sign localhost. */
export interface TestKeypair {
  publicKeyHex: string;
  privateKey: KeyObject;
}

const ED25519_SPKI_PREFIX_LENGTH = 12; // bytes before the raw 32-byte key in a DER SPKI export

export function generateTestKeypair(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKeyHex: spki.subarray(ED25519_SPKI_PREFIX_LENGTH).toString('hex'), privateKey };
}

export interface SignedHeaders {
  'x-signature-ed25519': string;
  'x-signature-timestamp': string;
}

/** Signs `timestamp + body` exactly as Discord does (DESIGN §4). */
export function signRequest(
  keypair: TestKeypair,
  timestamp: string,
  body: string | Buffer,
): SignedHeaders {
  const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body)]);
  return {
    'x-signature-ed25519': sign(null, message, keypair.privateKey).toString('hex'),
    'x-signature-timestamp': timestamp,
  };
}

/** Unix seconds as the string Discord sends in `X-Signature-Timestamp`. */
export function unixSeconds(ms: number): string {
  return String(Math.floor(ms / 1000));
}
