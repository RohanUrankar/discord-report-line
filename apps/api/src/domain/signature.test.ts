import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_FUTURE_SKEW_MS,
  REPLAY_WINDOW_MS,
  isTimestampFresh,
  verifySignature,
} from './signature.js';

// Self-generated keypair: Discord cannot sign for tests, so we play Discord (CLAUDE.md "Verify these").
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_HEX = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');
const OTHER_PUBLIC_KEY_HEX = generateKeyPairSync('ed25519')
  .publicKey.export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');

const TIMESTAMP = '1760000000';
const BODY = Buffer.from('{"id":"123","type":1,"application_id":"1","token":"t","version":1}');

function signHex(timestamp: string, body: Buffer): string {
  return sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
}

const VALID_SIGNATURE = signHex(TIMESTAMP, BODY);

describe('verifySignature', () => {
  it('WHEN the signature over timestamp + raw body is valid THE SYSTEM SHALL accept it', () => {
    expect(verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE, PUBLIC_KEY_HEX)).toBe(true);
  });

  it('accepts an upper-case hex signature and key (hex is case-insensitive)', () => {
    expect(
      verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE.toUpperCase(), PUBLIC_KEY_HEX.toUpperCase()),
    ).toBe(true);
  });

  it('WHEN the body is tampered THE SYSTEM SHALL reject it', () => {
    const tampered = Buffer.from(BODY.toString().replace('"type":1', '"type":2'));
    expect(verifySignature(TIMESTAMP, tampered, VALID_SIGNATURE, PUBLIC_KEY_HEX)).toBe(false);
  });

  it('WHEN the body is re-serialised JSON rather than the raw bytes THE SYSTEM SHALL reject it', () => {
    const spaced = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 1));
    expect(verifySignature(TIMESTAMP, spaced, VALID_SIGNATURE, PUBLIC_KEY_HEX)).toBe(false);
  });

  it('WHEN the timestamp is tampered THE SYSTEM SHALL reject it', () => {
    expect(verifySignature('1760000001', BODY, VALID_SIGNATURE, PUBLIC_KEY_HEX)).toBe(false);
  });

  it('WHEN the request was signed by a different key THE SYSTEM SHALL reject it', () => {
    expect(verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE, OTHER_PUBLIC_KEY_HEX)).toBe(false);
  });

  it('WHEN one bit of the signature is flipped THE SYSTEM SHALL reject it', () => {
    const flipped = (VALID_SIGNATURE.startsWith('0') ? '1' : '0') + VALID_SIGNATURE.slice(1);
    expect(verifySignature(TIMESTAMP, BODY, flipped, PUBLIC_KEY_HEX)).toBe(false);
  });

  describe('missing headers or body return false', () => {
    it.each([
      ['timestamp header missing', undefined, BODY, VALID_SIGNATURE],
      ['timestamp header empty', '', BODY, VALID_SIGNATURE],
      ['signature header missing', TIMESTAMP, BODY, undefined],
      ['signature header empty', TIMESTAMP, BODY, ''],
      ['body missing', TIMESTAMP, undefined, VALID_SIGNATURE],
      ['body empty', TIMESTAMP, Buffer.alloc(0), VALID_SIGNATURE],
    ])('%s', (_case, timestamp, body, signature) => {
      expect(verifySignature(timestamp, body, signature, PUBLIC_KEY_HEX)).toBe(false);
    });
  });

  describe('malformed hex returns false and never throws', () => {
    it.each([
      ['non-hex characters', 'zz' + VALID_SIGNATURE.slice(2)],
      ['too short (63 bytes)', VALID_SIGNATURE.slice(0, 126)],
      ['too long (65 bytes)', VALID_SIGNATURE + '00'],
      ['odd length', VALID_SIGNATURE.slice(0, 127)],
      ['whitespace padded', ` ${VALID_SIGNATURE.slice(1)}`],
      ['0x prefixed', '0x' + VALID_SIGNATURE.slice(2)],
    ])('signature: %s', (_case, signature) => {
      expect(() => verifySignature(TIMESTAMP, BODY, signature, PUBLIC_KEY_HEX)).not.toThrow();
      expect(verifySignature(TIMESTAMP, BODY, signature, PUBLIC_KEY_HEX)).toBe(false);
    });

    it.each([
      ['empty', ''],
      ['non-hex characters', 'zz' + PUBLIC_KEY_HEX.slice(2)],
      ['too short', PUBLIC_KEY_HEX.slice(0, 62)],
      ['too long', PUBLIC_KEY_HEX + '00'],
    ])('public key: %s', (_case, key) => {
      expect(() => verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE, key)).not.toThrow();
      expect(verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE, key)).toBe(false);
    });

    it('a well-formed 32-byte key that is not a valid Ed25519 point returns false without throwing', () => {
      const notAPoint = 'ff'.repeat(32);
      expect(() => verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE, notAPoint)).not.toThrow();
      expect(verifySignature(TIMESTAMP, BODY, VALID_SIGNATURE, notAPoint)).toBe(false);
    });
  });
});

describe('isTimestampFresh', () => {
  const SENT_AT_MS = Number(TIMESTAMP) * 1000;

  it('accepts a timestamp from the current second', () => {
    expect(isTimestampFresh(TIMESTAMP, SENT_AT_MS)).toBe(true);
  });

  it('accepts a timestamp exactly at the 5-minute boundary', () => {
    expect(isTimestampFresh(TIMESTAMP, SENT_AT_MS + REPLAY_WINDOW_MS)).toBe(true);
  });

  it('WHEN a request timestamp is older than 5 minutes THE SYSTEM SHALL reject it', () => {
    expect(isTimestampFresh(TIMESTAMP, SENT_AT_MS + REPLAY_WINDOW_MS + 1)).toBe(false);
  });

  it('accepts a timestamp up to the future-skew tolerance ahead of our clock', () => {
    expect(isTimestampFresh(TIMESTAMP, SENT_AT_MS - MAX_FUTURE_SKEW_MS)).toBe(true);
  });

  it('rejects a timestamp further ahead than the future-skew tolerance', () => {
    expect(isTimestampFresh(TIMESTAMP, SENT_AT_MS - MAX_FUTURE_SKEW_MS - 1)).toBe(false);
  });

  it('rejects a 12-digit timestamp thousands of years ahead', () => {
    expect(isTimestampFresh('999999999999', SENT_AT_MS)).toBe(false);
  });

  it('honours a caller-supplied window', () => {
    expect(isTimestampFresh(TIMESTAMP, SENT_AT_MS + 2_000, 1_000)).toBe(false);
  });

  it.each([[''], ['abc'], ['-5'], ['1.5'], ['1e9'], [' 1760000000'], ['9'.repeat(13)]])(
    'treats malformed timestamp %j as not fresh',
    (timestamp) => {
      expect(isTimestampFresh(timestamp, SENT_AT_MS)).toBe(false);
    },
  );
});
