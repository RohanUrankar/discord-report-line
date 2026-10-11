import type pg from 'pg';

import type { AdminRecord, AdminRepository } from '../../ports/auth.js';

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
}

export class PgAdminRepository implements AdminRepository {
  public constructor(private readonly pool: pg.Pool) {}

  public async findByEmail(email: string): Promise<AdminRecord | undefined> {
    const { rows } = await this.pool.query<AdminRow>(
      'SELECT id, email, password_hash FROM admin WHERE email = $1',
      [email],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, email: row.email, passwordHash: row.password_hash };
  }

  /**
   * One transaction: a new password ends the admin's existing sessions (security-secrets), and the session
   * delete must not happen without the password change or the reverse.
   */
  public async upsert(email: string, passwordHash: string): Promise<{ id: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO admin (email, password_hash) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [email, passwordHash],
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error('Admin upsert returned no row.');
      }
      await client.query('DELETE FROM session WHERE admin_id = $1', [id]);
      await client.query('COMMIT');
      return { id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
