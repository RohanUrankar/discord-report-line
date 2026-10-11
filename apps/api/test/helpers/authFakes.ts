import { NodeSessionCrypto } from '../../src/adapters/nodeSessionCrypto.js';
import { AuthService } from '../../src/app/auth.js';
import type { SessionCookieSettings } from '../../src/http/sessionCookie.js';
import type {
  AdminRecord,
  AdminRepository,
  PasswordHasher,
  SessionRepository,
  StoredSession,
} from '../../src/ports/auth.js';
import type { Clock } from '../../src/ports/clock.js';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const TEST_TTL_MS = 60 * 60_000;
export const SECURE_COOKIE: SessionCookieSettings = { secure: true, ttlMs: TEST_TTL_MS };

/** A clock the test moves by hand. */
export class ManualClock implements Clock {
  public constructor(private current: number) {}

  public nowMs(): number {
    return this.current;
  }

  public advance(ms: number): void {
    this.current += ms;
  }
}

/** Hashing without the cost: "hash:<password>". Counts verifies so a test can prove the dummy check ran. */
export class PlainHasher implements PasswordHasher {
  public verifyCalls: { passwordHash: string; password: string }[] = [];

  public hash(password: string): Promise<string> {
    return Promise.resolve(`hash:${password}`);
  }

  public verify(passwordHash: string, password: string): Promise<boolean> {
    this.verifyCalls.push({ passwordHash, password });
    return Promise.resolve(passwordHash === `hash:${password}`);
  }
}

export class InMemoryAdmins implements AdminRepository {
  public readonly byEmail = new Map<string, AdminRecord>();

  public findByEmail(email: string): Promise<AdminRecord | undefined> {
    return Promise.resolve(this.byEmail.get(email));
  }

  public upsert(email: string, passwordHash: string): Promise<{ id: string }> {
    const id =
      this.byEmail.get(email)?.id ??
      `00000000-0000-4000-8000-${String(this.byEmail.size + 1).padStart(12, '0')}`;
    this.byEmail.set(email, { id, email, passwordHash });
    return Promise.resolve({ id });
  }
}

export class InMemorySessions implements SessionRepository {
  public readonly byHash = new Map<string, { adminId: string; expiresAt: Date }>();

  public constructor(private readonly admins: InMemoryAdmins) {}

  public create(session: { idHash: string; adminId: string; expiresAt: Date }): Promise<void> {
    this.byHash.set(session.idHash, { adminId: session.adminId, expiresAt: session.expiresAt });
    return Promise.resolve();
  }

  public findByIdHash(idHash: string): Promise<StoredSession | undefined> {
    const row = this.byHash.get(idHash);
    const admin = [...this.admins.byEmail.values()].find((a) => a.id === row?.adminId);
    if (row === undefined || admin === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ adminId: row.adminId, email: admin.email, expiresAt: row.expiresAt });
  }

  public delete(idHash: string): Promise<void> {
    this.byHash.delete(idHash);
    return Promise.resolve();
  }

  public deleteExpired(before: Date): Promise<void> {
    for (const [hash, row] of this.byHash) {
      if (row.expiresAt <= before) {
        this.byHash.delete(hash);
      }
    }
    return Promise.resolve();
  }
}

export interface AuthKit {
  auth: AuthService;
  admins: InMemoryAdmins;
  sessions: InMemorySessions;
  hasher: PlainHasher;
  clock: ManualClock;
  cookie: SessionCookieSettings;
}

/** An AuthService over in-memory fakes with real session cryptography. */
export function makeAuthKit(startMs = Date.UTC(2026, 9, 11, 15, 30)): AuthKit {
  const admins = new InMemoryAdmins();
  const sessions = new InMemorySessions(admins);
  const hasher = new PlainHasher();
  const clock = new ManualClock(startMs);
  const auth = new AuthService(
    { admins, sessions, hasher, sessionCrypto: new NodeSessionCrypto(TEST_SESSION_SECRET), clock },
    { sessionTtlMs: TEST_TTL_MS },
  );
  return { auth, admins, sessions, hasher, clock, cookie: SECURE_COOKIE };
}

/** For tests of other routes that need a `createServer` but never sign in. */
export function inertAuth(): { auth: AuthService; cookie: SessionCookieSettings } {
  const { auth, cookie } = makeAuthKit();
  return { auth, cookie };
}

export const ADMIN_EMAIL = 'admin@example.test';
export const ADMIN_PASSWORD = 'correct horse battery';

export async function addAdmin(kit: AuthKit): Promise<string> {
  const { id } = await kit.admins.upsert(ADMIN_EMAIL, await kit.hasher.hash(ADMIN_PASSWORD));
  return id;
}
