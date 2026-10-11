import type { AdminRepository, PasswordHasher } from '../ports/auth.js';

export interface SeedAdminDeps {
  admins: AdminRepository;
  hasher: PasswordHasher;
}

/**
 * Creates the throwaway admin, or resets its password if the email already exists (which also ends its
 * sessions). The email is stored lower-cased because login lower-cases what it is given.
 */
export async function seedAdmin(
  credentials: { email: string; password: string },
  { admins, hasher }: SeedAdminDeps,
): Promise<{ id: string; email: string }> {
  const email = credentials.email.trim().toLowerCase();
  const { id } = await admins.upsert(email, await hasher.hash(credentials.password));
  return { id, email };
}
