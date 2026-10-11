# 0004 — Domain import allow-list: name `node:crypto` (and fix the §8.3 re-export comment)

**Status:** Accepted, Option A, 2026-10-11 (DESIGN rev 3.1: §7). The §8.3 comment was already corrected in rev 3; the device copy had a stale line from an out-of-order write, now fixed.
**Raised by:** backend-implementer, while converting domain's lint rule to the rev 3 allow-list
**Blocks:** only the final form of the domain lint rule. All domain code is written and passing.

## Context

| DESIGN rev 3 | Says |
|---|---|
| §7 dependency rule | "`domain` imports **only** `domain`, `@report-line/shared` and `zod`, all of which are I/O-free." |
| §7 module tree, §8.1 | `domain/signature.ts`: `verifySignature(...): boolean`, synchronous |
| §4 build notes | Use `discord-interactions` `verifyKey`, or "`node:crypto` Ed25519 (`crypto.verify(null, msg, keyObject, sig)`) is a zero-dependency alternative" |
| CLAUDE.md | "Use `discord-interactions` `verifyKey` (or `tweetnacl`/`node:crypto`)" |

`domain/signature.ts` has used `node:crypto` since round 1, because `verifyKey` is async and §8.1 requires a synchronous boolean (ai-journal entry, 2026-10-11). Every Ed25519 option that CLAUDE.md allows is outside the three names §7 now lists, and hand-rolling Ed25519 is ruled out ("never write your own crypto"). So the "only" list in §7 cannot hold for a file §7 itself places in `domain/`.

A strict allow-list written to the letter of §7 would fail lint on `signature.ts`. For now domain keeps the existing deny-list, which bans I/O libraries, `fetch`, `process`, `Math.random`, `Date.now`, relative imports outside `domain/` and deep imports into `@report-line/shared`. That list allows `@report-line/shared`, `zod` and `node:crypto`, but it would also let a new third-party package in without a lint error.

A second, cosmetic issue: §8.3's `domain/types.ts` comment says `export * from '@report-line/shared/enums'`, which is a deep, wildcard import. The relayed instruction for this round says to re-export by name from the package root with no deep imports. I followed the instruction: there are named re-exports from `@report-line/shared`, and lint now bans `@report-line/shared/*` inside domain.

## Proposal (recommended: Option A)

**Option A (recommended): amend §7 to name it.** Change the rule to "`domain` imports only `domain`, `@report-line/shared`, `zod`, and `node:crypto` (pure computation, used by `signature.ts` only)." Then turn domain's lint rule into a strict allow-list. Any bare import other than those four is an error, and `node:crypto` is allowed in `signature.ts` only. Also change the §8.3 comment to "re-exported by name from `@report-line/shared`".

**Option B: move signature verification out of domain** into an adapter behind a `SignatureVerifier` port. This keeps §7's three-name list literal, but it changes the §7 tree and §8.1, and it turns the most-tested pure function into an injected collaborator for no benefit.

**Option C: leave it as is**, with the deny-list and the §7 wording unchanged. The docs and the code then disagree, and nothing mechanical stops a new dependency from creeping into domain.

## Consequences (Option A)

- One sentence changes in §7, plus the §8.3 comment. There are no code changes beyond `apps/api/eslint.config.js` (about 10 lines).
- No interface, data-model or frontend impact.
