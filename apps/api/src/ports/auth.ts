/** Hashes and checks admin passwords. `verify` never throws: an unreadable hash is simply "no match". */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

/**
 * The cryptography behind sessions (security-secrets): ids and the values derived from them. The raw session
 * id exists only in the cookie; the database holds `hashSessionId(id)`.
 */
export interface SessionCrypto {
  newSessionId(): string;
  /** True for a value shaped like one `newSessionId` returns, so junk in a cookie never reaches the database. */
  isWellFormed(sessionId: string): boolean;
  hashSessionId(sessionId: string): string;
  /** The per-session CSRF token. Derived, so it needs no column and cannot be guessed from the stored hash. */
  csrfTokenFor(sessionId: string): string;
  /** Constant-time comparison of two tokens. A missing or differently sized value is simply a mismatch. */
  tokensEqual(expected: string, supplied: string | undefined): boolean;
}

export interface AdminRecord {
  id: string;
  email: string;
  passwordHash: string;
}

export interface AdminRepository {
  /** `email` is already lower-cased. */
  findByEmail(email: string): Promise<AdminRecord | undefined>;
  /** Creates the admin or replaces its password hash, and ends that admin's sessions when it changed. */
  upsert(email: string, passwordHash: string): Promise<{ id: string }>;
}

export interface StoredSession {
  adminId: string;
  email: string;
  expiresAt: Date;
}

export interface SessionRepository {
  create(session: { idHash: string; adminId: string; expiresAt: Date }): Promise<void>;
  /** Returns the session even if it has expired; the caller decides, so an expired one can be told apart. */
  findByIdHash(idHash: string): Promise<StoredSession | undefined>;
  delete(idHash: string): Promise<void>;
  /** Housekeeping: removes every session that expired before `before`. */
  deleteExpired(before: Date): Promise<void>;
}
