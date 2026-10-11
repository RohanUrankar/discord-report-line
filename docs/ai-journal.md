# AI journal

Running log of moments where an AI agent's assumption or generated code turned out wrong, how it was noticed, and how it was fixed. Format and rules: `.claude/skills/ai-journal/SKILL.md`. Source material for `AI_NOTES.md`.

<!-- Newest entries at the bottom. -->

### 2026-10-11 — design/retry: AI-written design and skill disagree on which 4xx to retry
- **Believed / generated:** DESIGN §14 (AI-assisted) says Discord follow-up "401/404 → if < 15 min, retry"; the AI-written `resilience` skill lists 408/425 as retryable. CLAUDE.md and DESIGN §8.1 say every 4xx except 429 is fatal, and the §8.1 `classifyFailure({status?, kind?})` signature has no token-age input to express §14's rule.
- **Noticed by:** backend-implementer cross-reading §14 against §8.1 and CLAUDE.md before writing `classifyFailure`; no code was written for it.
- **Root cause:** the failure catalogue was written per integration while the classifier contract was written generically, and neither was checked against the other. Retrying a deterministic 401 would also count toward Discord's invalid-request (Cloudflare ban) limit.
- **Fix:** implementation stopped; `architecture/docs/proposals/0001-retry-classification-discord-followup-4xx.md` recommends keeping 4xx fatal, with immediate bot-token channel fallback for follow-up 401/404.
- **Cost:** caught before any code. Shipped as written, it would have burned 8 attempts per job on a dead token and risked an IP ban.
- **Lesson → guardrail:** proposal pending. Once accepted, a `classifyFailure` table test pins 401/404/408/425 → fatal.

### 2026-10-11 — design/signature: recommended library's API does not fit the contract it was recommended for
- **Believed / generated:** DESIGN §4 says to use `discord-interactions` `verifyKey`, while §8.1 specifies `verifySignature(...): boolean` (synchronous). `verifyKey` returns `Promise<boolean>`, so dropping it into a sync boolean contract invites the un-awaited-Promise-is-truthy bug that accepts every forged request.
- **Noticed by:** backend-implementer, comparing §4 with the §8.1 signature while writing `domain/signature.ts`.
- **Root cause:** library recommendation and interface written separately; the async nature of `verifyKey` (v4+) was not carried into the contract.
- **Fix:** `apps/api/src/domain/signature.ts` uses `node:crypto` `verify(null, …)` with an SPKI-wrapped raw key (the alternative §4 and CLAUDE.md already allow), so it is synchronous and has no dependency. Tests cover tampered body/timestamp, wrong key, missing headers, bad hex and an invalid curve point.
- **Cost:** none (caught before code). Had it been used un-awaited, forged requests would have been accepted, and Discord would have removed the endpoint.
- **Lesson → guardrail:** `signature.test.ts` asserts `false` for forged input, which an un-awaited Promise would fail.

### 2026-10-11 — design/modules: my proposal split the shared contract across domain and packages/shared without a dependency direction
- **Believed / generated:** proposal 0002 (backend-implementer, me) put the status enums in `domain/types.ts` and the rule schema in `packages/shared`. Rev 2 adopted it verbatim: "enum … in `domain/types.ts` (exported to `packages/shared`)" (§8.3) next to "rule schemas live in packages/shared", which `domain/rules.ts` must import, while §7 still says "`domain` imports nothing outside `domain`".
- **Noticed by:** the orchestrator's resume note asked how domain may depend on packages/shared. Re-reading rev 2 §7 line 337 against §8.3 lines 525/551/589 showed a violation of §7 and a shared↔api package cycle.
- **Root cause:** I placed each artefact where it "felt" right without drawing the import graph. The architect accepted it, and nobody checked §7 against the new §8.3.
- **Fix:** implementation stopped before `types.ts`/`rules.ts`. `architecture/docs/proposals/0003-domain-shared-dependency-direction.md` recommends making shared a pure leaf package that domain may import, enforced by lint.
- **Cost:** caught before code. Shipped as written, the frontend would build against a package that imports the backend, or the schemas would be duplicated and drift.
- **Lesson → guardrail:** when a proposal moves a type between packages, state the import direction explicitly. Once accepted, a lint rule on `packages/shared` will ban `apps/*`, `node:*` and I/O imports.

### 2026-10-11 — design/modules: my proposal 0003 wrote an allow-list that excludes my own signature.ts
- **Believed / generated:** proposal 0003 (backend-implementer, me) recommended "domain imports only domain, `@report-line/shared` and `zod`". Rev 3 adopted it verbatim in §7. But `domain/signature.ts`, which I wrote in round 1, imports `node:crypto`, the Ed25519 option CLAUDE.md and §4 allow.
- **Noticed by:** converting domain's lint rule to the rev 3 allow-list. Written to the letter, it would fail lint on `signature.ts`.
- **Root cause:** I wrote the allow-list from the new dependency (shared) and didn't diff it against the imports already in `domain/`. A one-line `grep "^import" src/domain/*.ts` would have caught it.
- **Fix:** domain keeps the existing deny-list (which allows shared, zod and node:crypto). `architecture/docs/proposals/0004-domain-allow-list-node-crypto.md` recommends naming `node:crypto` (for signature.ts only) in §7 and then switching to a strict allow-list.
- **Cost:** none in code. The doc contradicted itself for one revision, which cost one extra round with the architect.
- **Lesson → guardrail:** before proposing an import rule, grep the current imports of the folder it governs. Once 0004 is accepted, the rule becomes a strict allow-list lint.
