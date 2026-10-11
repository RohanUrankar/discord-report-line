# TypeScript style rulebook (apps/api, packages/shared, scripts)

The reasoning is given with each rule so you can judge edge cases instead of pattern-matching. Prettier handles whitespace; everything here is about meaning.

## Contents
1. Names and files
2. Types
3. Closed sets: unions, `as const`, exhaustiveness
4. Functions and async
5. Control flow
6. Classes
7. Modules and imports
8. Objects, mutation and maps
9. Errors
10. Comments
11. Prohibited patterns

---

## 1. Names and files

- Files and folders: lowercase `kebab-case` (`job-worker.ts`); tests `job-worker.test.ts`. One primary class or concept per file, file named after it.
- `lowerCamelCase` variables/functions, `PascalCase` types/classes, `UPPER_SNAKE_CASE` module-level constants. Types and interfaces have no `I` prefix (`SlackMirror`, not `ISlackMirror`) so an implementation can be swapped without renaming.
- Generic parameters are descriptive: `TItem`, `TKey` — not bare `T` when more than one exists or the meaning isn't obvious at the call site.
- No single-letter names outside tiny loop indices/lambdas of one expression. Booleans read as predicates: `isExpired`, `hasMirror`, `canRetry`.
- Name by domain meaning, not by type: `mirrorMessage`, not `data`; `retryAt`, not `time2`.

## 2. Types

- `strict` on, plus the extra flags in `enforcement.md`. They exist because each one catches a class of bug that otherwise reaches production.
- **No `any`.** At a trust boundary use `unknown` and narrow (zod `parse`, `typeof`, `instanceof`). A cast hides the problem; a parser removes it.
  ```ts
  // ✗ pretends the network is typed
  const body = (await res.json()) as SlackResponse;
  // ✓ parse it
  const body = slackResponseSchema.parse(await res.json());
  ```
- **No `as` assertions** except (a) `as const`, (b) directly after a check that proves it, with a comment. No non-null `!` unless provably safe and commented.
- `@ts-ignore` is banned. If TypeScript is wrong and you must suppress, `// @ts-expect-error <reason + issue>` — it fails the build once the suppression is no longer needed.
- `interface` for object shapes that are implemented or extended (ports!); `type` for unions, intersections, mapped/derived types and aliases.
- `readonly` on properties and `ReadonlyArray`/`readonly T[]` on parameters you don't mutate. Immutability by default makes concurrency (the worker processes jobs in parallel) easier to reason about.
- Use `satisfies` to check a literal against a type without widening it (config tables, route maps).
- Branded ids for identifiers that must not be mixed (`GuildId`, `ChannelId`, `JobId`):
  ```ts
  export type GuildId = string & { readonly __brand: 'GuildId' };
  export const guildIdSchema = z.string().regex(/^\d{17,20}$/).transform((s) => s as GuildId);
  ```
  The one cast lives inside the schema that proves validity.
- Avoid optional-property sprawl: if three fields are either all present or all absent, that's a union (`{ kind: 'sent'; messageId: string } | { kind: 'skipped' }`), not three `?` fields.
- Prefer returning a result union over `null`/`undefined` plus a side channel when failure reasons matter to the caller.

## 3. Closed sets: unions, `as const`, exhaustiveness

Don't use `enum` or `const enum`. `const enum` is erased/inlined in ways that break under `isolatedModules` and esbuild/Vitest transpilation, and regular enums emit runtime objects with surprising reverse mappings. Use a frozen object plus a derived union:

```ts
export const JOB_STATUS = {
  Pending: 'pending',
  Running: 'running',
  Done: 'done',
  Dead: 'dead',
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];
```

String values (not numbers) so logs, the database and the dashboard stay readable. Mirror the same values in a Postgres `CHECK` constraint.

Branch on a closed set with an exhaustive `switch`; the `default` is a compile-time guarantee, not a shrug:

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

switch (outcome.kind) {
  case 'success':
    return markDone(job);
  case 'retryable':
    return scheduleRetry(job, outcome.retryAfterMs);
  case 'fatal':
    return markDead(job, outcome.reason);
  default:
    return assertNever(outcome);
}
```

Rules for `switch`: always a `default`; every case returns or `break`s (no fall-through unless commented as intentional); past ~10 cases a `Record<Key, Handler>` lookup (or `Map`) is clearer than a `switch`.

## 4. Functions and async

- Small and single-purpose: aim ≲30 lines. If you need a comment to separate "phases", those are functions.
- Explicit return types on every exported function (and on anything non-trivial) — the signature is the contract, and inference can silently widen it when the body changes.
- Early return / guard clauses instead of nested `else`. Max nesting depth 3.
  ```ts
  // ✓
  if (!job) return null;
  if (job.status !== JOB_STATUS.Pending) return null;
  return claim(job);
  ```
- More than ~3 parameters, or several booleans → one options object with named fields. A call like `send(a, b, true, false)` is unreadable.
- Name callbacks and extract multi-line lambdas into named functions: stack traces and test failures then say something useful.
- Chain array methods one per line when there are two or more.
- `async/await` over `.then` chains. `await` inside `try` when you intend to catch the rejection (`return await` in a try block; a bare `return promise` escapes the catch).
- **Never leave a promise floating.** Either `await` it, or `void`+`.catch(logError)` it deliberately for fire-and-forget (and justify in a comment). A rejected floating promise becomes an `unhandledRejection` and takes the process down.
- Parallelism: `Promise.all` when failure of any should abort the group; `Promise.allSettled` when each item's outcome is handled independently (the worker batch). Bound the concurrency — never `Promise.all` over an unbounded list.
- Don't do CPU-heavy or `*Sync` work in a request path.
- Pure functions in `domain/` take their clock/random/config as arguments; this is what makes them testable without mocks.

## 5. Control flow

- `===` / `!==` only (ESLint `eqeqeq`). `null`/`undefined` checks: `== null` is the single tolerated exception only if the codebase already uses it; otherwise be explicit.
- Extract a compound condition into a named boolean so the intent reads at the `if`:
  ```ts
  const isReplay = ageMs > REPLAY_WINDOW_MS;
  const isFromFuture = ageMs < -CLOCK_SKEW_MS;
  if (isReplay || isFromFuture) return reject('stale_timestamp');
  ```
- Always braces, even for one-line bodies.
- An `if / else if` chain over a closed set belongs in an exhaustive `switch`; over open conditions, end it with an `else` (or a comment saying why none is needed) so the unhandled case is a decision, not an accident.
- No magic numbers or strings — a named constant says what the number means and gives you one place to change it:
  ```ts
  const MAX_ATTEMPTS = 5;            // ✓
  if (job.attempts >= MAX_ATTEMPTS)  // ✗ `>= 5`
  ```

## 6. Classes

Use classes for stateful collaborators with injected dependencies (a worker, a repository adapter); use plain functions for stateless logic. No DI container or decorators — constructor injection of ports is enough and keeps tests trivial.

```ts
export class JobWorker {
  public constructor(
    private readonly jobs: JobRepository,
    private readonly mirror: SlackMirror,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  public async runOnce(): Promise<void> { /* … */ }

  private async process(job: Job): Promise<Outcome> { /* … */ }
}
```

- Explicit `public`/`private`/`protected` on every member; `private` unless something outside needs it. This documents the surface other code may depend on.
- `readonly` for injected dependencies and anything assigned once.
- No property setters; name mutations as methods (`markDone()`), so side effects are visible at the call site. Getters must be side-effect-free and cheap.
- No deep inheritance. Shared behaviour → composition or a function. If you reach for `extends` outside `Error`, justify it.
- Don't mix concerns: a class doing transport + business logic + response shaping is three classes.
- Avoid `this`-dependent callbacks passed around (`arr.map(this.fn)`); bind via an arrow or pass a function.

## 7. Modules and imports

- ES modules only (`import`/`export`), never `require` in TS source. Use the `node:` prefix for built-ins.
- Import groups separated by a blank line: Node built-ins → third-party → internal (absolute/alias) → relative. Use `import type` for type-only imports (clearer, and required with `verbatimModuleSyntax`).
- Named exports by default; a default export only for a file whose one purpose is a single obvious thing. Named exports refactor and grep better.
- **No circular imports.** Dependencies flow `http → app → domain`, `adapters → ports`. If two modules need each other, the shared concept belongs in a third (usually `domain/types`) or one of them should receive the other through a port. Enforce with `import/no-cycle` or dependency-cruiser.
- No barrel files that re-export whole directories inside `domain/` and `app/` — they invite cycles and slow test start-up.
- Every file has one responsibility that you can state in one sentence.

## 8. Objects, mutation and maps

- Literals (`[]`, `{}`), not `new Array()`/`new Object()`.
- Don't mutate arguments. Return new values (`{ ...job, status }`), especially in `domain/`.
- Don't use `delete` on objects — build a new object without the key (`const { token: _t, ...safe } = job`) or use a `Map`. Beyond deoptimising engines, `delete` is usually a sign of a shape that should be explicit.
- For collections keyed by external/untrusted strings (command names, custom_ids, header names) use a `Map`, or `Object.create(null)`, so keys like `__proto__` or `constructor` can't collide with prototype members. Never `Object.assign`/spread untrusted input into a config or domain object — parse it with a zod schema first so only known keys survive.
- Don't modify built-in prototypes.

## 9. Errors

- Throw `Error` subclasses, never strings or plain objects. One `AppError` with a stable `code` is defined in the `resilience` skill; extend it only if a caller must distinguish by type.
- Preserve causes: `throw new AppError({ code: 'MIRROR_FAILED', cause: err })`. A stack trace that stops at your wrapper is a debugging dead end.
- `catch (err)` is `unknown` — narrow before use (`err instanceof AppError`, `err instanceof Error`). Never `catch (e: any)`.
- No empty `catch`. Either handle it meaningfully, log it with context, or rethrow. If swallowing is truly correct (e.g. best-effort cleanup), say why in a comment.
- Catch only where you can do something useful (add context, translate, recover, or the process edge). Catching and rethrowing the same error unchanged is noise. Log each error once, at the edge — see `resilience`.
- Never put secrets or user-supplied text into error messages that may be returned to a client or logged unredacted.

## 10. Comments

- Explain *why*: a Discord quirk, a security reason, a non-obvious invariant, a trade-off. Never narrate what the next line does.
- Public functions in `domain/` with non-obvious contracts get a short TSDoc comment (inputs, units, thrown errors). No ceremonial banners or boilerplate on every function.
- `TODO` must say what and why, and a TODO standing in for a promised behaviour is unfinished work, not a TODO.
- Delete dead code and commented-out blocks; git remembers.

## 11. Prohibited patterns

| Pattern | Why / instead |
|---|---|
| `eval`, `new Function`, `with`, `vm.run*` on any input | Remote code execution |
| `any`, `as any`, `@ts-ignore`, unjustified `!` | Defeats the type system — `unknown` + parse |
| `enum`, `const enum` | See §3 |
| `console.*` in app code | Use the pino logger (redaction, levels, correlation) |
| `debugger` | Will ship and halt a process |
| Floating promises, empty `catch` | Silent failure / process crash |
| `delete obj.key`, mutating arguments | See §8 |
| Copy-pasted blocks | Extract a function — but only when it's the same *knowledge*; look-alikes encoding different rules stay separate |
| Magic numbers/strings | Named constant or config |
| `*Sync` fs/crypto in request or worker paths | Blocks the event loop |
| String-built SQL, shell commands or file paths from input | Injection / traversal — parameters, argument arrays, resolved-path checks |
| `Math.random()` for ids, tokens, jitter in security paths | `crypto.randomBytes` / `randomUUID` (jitter uses the injected `random`) |
| Circular imports | See §7 |
| Hard-coded URLs, ports, timeouts, credentials | `config.ts` |
