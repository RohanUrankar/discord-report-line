import argon2 from 'argon2';

import type { PasswordHasher } from '../ports/auth.js';

// OWASP's argon2id minimum (19 MiB, 2 passes, 1 lane). Modest on purpose: the free-tier host has little memory
// and a login must not tie it up. Parameters are stored inside each hash, so raising them later still verifies
// old hashes.
const MEMORY_COST_KIB = 19_456;
const TIME_COST = 2;
const PARALLELISM = 1;

export class Argon2PasswordHasher implements PasswordHasher {
  public hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: MEMORY_COST_KIB,
      timeCost: TIME_COST,
      parallelism: PARALLELISM,
    });
  }

  public async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      // A malformed stored hash must read as "wrong password", never as a 500 that tells an attacker something.
      return false;
    }
  }
}
