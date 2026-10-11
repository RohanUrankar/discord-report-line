import { createPublicKey, verify } from 'node:crypto';

/** Reject signed requests whose timestamp is further than this from now (DESIGN §7.1, §13 T-03). */
export const REPLAY_WINDOW_MS = 5 * 60_000;

/**
 * How far AHEAD of our clock a signed timestamp may be. Discord stamps a request when it sends it, so a future
 * timestamp can only mean our clock is slow. NTP-synced hosts are within milliseconds, so 60 s is generous for
 * that, and anything further ahead is not a request Discord just sent (DESIGN rev 8, §13 T-03).
 */
export const MAX_FUTURE_SKEW_MS = 60_000;

const SIGNATURE_HEX = /^[0-9a-fA-F]{128}$/; // Ed25519 signature: 64 bytes
const PUBLIC_KEY_HEX = /^[0-9a-fA-F]{64}$/; // Ed25519 public key: 32 bytes
const UNIX_SECONDS = /^\d{1,12}$/;
const MS_PER_SECOND = 1000;

// DER prefix that wraps a raw 32-byte Ed25519 key as SubjectPublicKeyInfo (RFC 8410), so node:crypto can load it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verifies Discord's Ed25519 signature over `timestamp + rawBody` (DESIGN §4, §8.1).
 *
 * Returns false and never throws on missing headers, empty body, non-hex or wrong-length input,
 * or a bad signature. Hex is validated explicitly because `Buffer.from('zz', 'hex')` silently truncates.
 * node:crypto is used rather than `discord-interactions`' `verifyKey` because the latter is async and the
 * contract here is a synchronous boolean (an un-awaited Promise is truthy and would accept forgeries).
 */
export function verifySignature(
  timestamp: string | undefined,
  rawBody: Buffer | undefined,
  signatureHex: string | undefined,
  publicKeyHex: string,
): boolean {
  if (!timestamp || !rawBody || rawBody.length === 0 || !signatureHex) {
    return false;
  }
  if (!SIGNATURE_HEX.test(signatureHex) || !PUBLIC_KEY_HEX.test(publicKeyHex)) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
    return verify(null, message, publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    // A key that is valid hex but not a usable Ed25519 point lands here: treat as unverified.
    return false;
  }
}

/**
 * Replay guard (CLAUDE.md, DESIGN §13 T-03). Call only AFTER `verifySignature` succeeds, since only then is
 * the timestamp trustworthy. `timestamp` is Discord's `X-Signature-Timestamp` (unix seconds).
 * Stale: older than `windowMs`. Early: more than `futureSkewMs` ahead of `nowMs`. A malformed timestamp
 * (anything but 1 to 12 digits) is never fresh.
 */
export function isTimestampFresh(
  timestamp: string,
  nowMs: number,
  windowMs: number = REPLAY_WINDOW_MS,
  futureSkewMs: number = MAX_FUTURE_SKEW_MS,
): boolean {
  if (!UNIX_SECONDS.test(timestamp)) {
    return false;
  }
  const ageMs = nowMs - Number(timestamp) * MS_PER_SECOND;
  return ageMs <= windowMs && ageMs >= -futureSkewMs;
}
