import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SessionCrypto } from '../ports/auth.js';

const SESSION_ID_BYTES = 32; // 256 bits, well past the 128-bit floor (security-secrets)
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes as unpadded base64url
const CSRF_CONTEXT = 'csrf:'; // keeps the CSRF HMAC from ever being valid for any other purpose

export class NodeSessionCrypto implements SessionCrypto {
  public constructor(private readonly secret: string) {}

  public newSessionId(): string {
    return randomBytes(SESSION_ID_BYTES).toString('base64url');
  }

  public isWellFormed(sessionId: string): boolean {
    return SESSION_ID_PATTERN.test(sessionId);
  }

  /** The session id has 256 bits of entropy, so a plain SHA-256 is enough to make the stored value useless. */
  public hashSessionId(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex');
  }

  public csrfTokenFor(sessionId: string): string {
    return createHmac('sha256', this.secret)
      .update(CSRF_CONTEXT + sessionId)
      .digest('base64url');
  }

  public tokensEqual(expected: string, supplied: string | undefined): boolean {
    if (supplied === undefined) {
      return false;
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
