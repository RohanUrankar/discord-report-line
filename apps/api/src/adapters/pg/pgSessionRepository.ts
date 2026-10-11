import type pg from 'pg';

import type { SessionRepository, StoredSession } from '../../ports/auth.js';

interface SessionRow {
  admin_id: string;
  email: string;
  expires_at: Date;
}

export class PgSessionRepository implements SessionRepository {
  public constructor(private readonly pool: pg.Pool) {}

  public async create(session: {
    idHash: string;
    adminId: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.pool.query('INSERT INTO session (id, admin_id, expires_at) VALUES ($1, $2, $3)', [
      session.idHash,
      session.adminId,
      session.expiresAt,
    ]);
  }

  public async findByIdHash(idHash: string): Promise<StoredSession | undefined> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT s.admin_id, a.email, s.expires_at
         FROM session s JOIN admin a ON a.id = s.admin_id
        WHERE s.id = $1`,
      [idHash],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { adminId: row.admin_id, email: row.email, expiresAt: row.expires_at };
  }

  public async delete(idHash: string): Promise<void> {
    await this.pool.query('DELETE FROM session WHERE id = $1', [idHash]);
  }

  public async deleteExpired(before: Date): Promise<void> {
    await this.pool.query('DELETE FROM session WHERE expires_at <= $1', [before]);
  }
}
