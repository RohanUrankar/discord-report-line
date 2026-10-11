import type {
  AdminRepository,
  PasswordHasher,
  SessionCrypto,
  SessionRepository,
} from '../ports/auth.js';
import type { Clock } from '../ports/clock.js';
import { WindowRateLimiter } from '../domain/windowRateLimiter.js';

/** Login throttle (SR-6): a tight limit per IP and email, a looser one per IP against email-spraying. */
export const LOGIN_LIMIT_PER_IP_AND_EMAIL = 5;
export const LOGIN_LIMIT_PER_IP = 20;
export const LOGIN_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

export interface AuthDeps {
  admins: AdminRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  sessionCrypto: SessionCrypto;
  clock: Clock;
}

export interface AuthOptions {
  /** Absolute session lifetime. There is no sliding renewal: a session ends this long after login. */
  sessionTtlMs: number;
}

/** What the rest of the API may know about the signed-in admin. Never holds the raw session id. */
export interface AuthenticatedAdmin {
  adminId: string;
  email: string;
  csrfToken: string;
}

export type LoginResult =
  | { kind: 'signed_in'; sessionId: string; expiresAt: Date; admin: AuthenticatedAdmin }
  | { kind: 'invalid_credentials' }
  | { kind: 'rate_limited'; retryAfterMs: number };

export type SessionCheck =
  | { kind: 'ok'; admin: AuthenticatedAdmin }
  | { kind: 'none' }
  | { kind: 'expired'; adminId: string };

export interface LoginAttempt {
  email: string;
  password: string;
  /** Client address, for throttling only. */
  ip: string;
  /** The session cookie the browser sent with the login, if any; it is ended so ids rotate (no fixation). */
  previousSessionId?: string | undefined;
}

/**
 * Admin sign-in, session lookup and sign-out (ADR-0003). Owns the decisions; the cookie, status codes and
 * logging belong to the HTTP edge. Wrong email and wrong password are indistinguishable: same result, and the
 * same work (an unknown email still pays for a hash check, so response time does not reveal which exist).
 */
export class AuthService {
  private readonly perIpAndEmail = new WindowRateLimiter({
    limit: LOGIN_LIMIT_PER_IP_AND_EMAIL,
    windowMs: LOGIN_WINDOW_MS,
    maxKeys: MAX_TRACKED_KEYS,
  });
  private readonly perIp = new WindowRateLimiter({
    limit: LOGIN_LIMIT_PER_IP,
    windowMs: LOGIN_WINDOW_MS,
    maxKeys: MAX_TRACKED_KEYS,
  });
  private dummyHash: Promise<string> | undefined;

  public constructor(
    private readonly deps: AuthDeps,
    private readonly options: AuthOptions,
  ) {}

  public async login(attempt: LoginAttempt): Promise<LoginResult> {
    const email = attempt.email.trim().toLowerCase();
    const nowMs = this.deps.clock.nowMs();
    const retryAfterMs = this.throttle(attempt.ip, email, nowMs);
    if (retryAfterMs > 0) {
      return { kind: 'rate_limited', retryAfterMs };
    }

    const admin = await this.deps.admins.findByEmail(email);
    const targetHash = admin?.passwordHash ?? (await this.getDummyHash());
    const matches = await this.deps.hasher.verify(targetHash, attempt.password);
    if (admin === undefined || !matches) {
      return { kind: 'invalid_credentials' };
    }
    return this.openSession(admin.id, admin.email, nowMs, attempt.previousSessionId);
  }

  /** Resolves a session cookie value. Expired sessions are removed and reported apart from absent ones. */
  public async authenticate(sessionId: string | undefined): Promise<SessionCheck> {
    const { sessionCrypto, sessions, clock } = this.deps;
    if (sessionId === undefined || !sessionCrypto.isWellFormed(sessionId)) {
      return { kind: 'none' };
    }
    const idHash = sessionCrypto.hashSessionId(sessionId);
    const stored = await sessions.findByIdHash(idHash);
    if (stored === undefined) {
      return { kind: 'none' };
    }
    if (stored.expiresAt.getTime() <= clock.nowMs()) {
      await sessions.delete(idHash);
      return { kind: 'expired', adminId: stored.adminId };
    }
    return {
      kind: 'ok',
      admin: {
        adminId: stored.adminId,
        email: stored.email,
        csrfToken: sessionCrypto.csrfTokenFor(sessionId),
      },
    };
  }

  public hasValidCsrf(admin: AuthenticatedAdmin, supplied: string | undefined): boolean {
    return this.deps.sessionCrypto.tokensEqual(admin.csrfToken, supplied);
  }

  public async logout(sessionId: string | undefined): Promise<void> {
    const { sessionCrypto, sessions } = this.deps;
    if (sessionId !== undefined && sessionCrypto.isWellFormed(sessionId)) {
      await sessions.delete(sessionCrypto.hashSessionId(sessionId));
    }
  }

  /** Counts the attempt against both limits and returns how long to wait, or 0 when it may proceed. */
  private throttle(ip: string, email: string, nowMs: number): number {
    const byIp = this.perIp.hit(ip, nowMs);
    const byIpAndEmail = this.perIpAndEmail.hit(`${ip}|${email}`, nowMs);
    return Math.max(byIp.retryAfterMs, byIpAndEmail.retryAfterMs);
  }

  /** Hashed once, on first use, with the same parameters as real hashes so the timing matches. */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.deps.hasher.hash(this.deps.sessionCrypto.newSessionId());
    return this.dummyHash;
  }

  private async openSession(
    adminId: string,
    email: string,
    nowMs: number,
    previousSessionId: string | undefined,
  ): Promise<LoginResult> {
    const { sessionCrypto, sessions } = this.deps;
    await this.logout(previousSessionId);
    await sessions.deleteExpired(new Date(nowMs));
    const sessionId = sessionCrypto.newSessionId();
    const expiresAt = new Date(nowMs + this.options.sessionTtlMs);
    await sessions.create({ idHash: sessionCrypto.hashSessionId(sessionId), adminId, expiresAt });
    return {
      kind: 'signed_in',
      sessionId,
      expiresAt,
      admin: { adminId, email, csrfToken: sessionCrypto.csrfTokenFor(sessionId) },
    };
  }
}
