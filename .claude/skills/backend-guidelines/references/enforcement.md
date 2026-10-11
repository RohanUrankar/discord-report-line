# Enforcing the rules mechanically

Rules written in prose are followed by the agent that read them and forgotten by the next one. The Stop hook runs typecheck/lint/test, so anything expressed here becomes a build failure rather than a review comment. Set these up in the scaffolding step and keep them strict from day one — loosening later is easy, tightening a messy codebase is not.

Rule and option names change between `typescript-eslint` and plugin versions: confirm against the installed versions (Context7 / the plugin docs) rather than pasting from memory.

## tsconfig (apps/api, packages/shared, scripts)

```jsonc
{
  "compilerOptions": {
    "strict": true,                       // noImplicitAny, strictNullChecks, strictFunctionTypes, …
    "noUncheckedIndexedAccess": true,     // arr[i] and record[key] are T | undefined — forces the check
    "exactOptionalPropertyTypes": true,   // `?: string` means "absent", not "undefined"
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,              // matches how Vitest/esbuild transpile
    "verbatimModuleSyntax": true,         // forces `import type`; keeps ESM honest
    "skipLibCheck": true
  }
}
```

`noUncheckedIndexedAccess` is the one people skip and regret: it is what stops `rows[0].id` from crashing on an empty result. If a flag causes noise in a place with a proven invariant, fix it locally with a narrow check, not by turning the flag off.

## ESLint (flat config, typescript-eslint with type-aware rules)

Use the `strictTypeChecked` + `stylisticTypeChecked` presets as the base, then make sure these are errors:

| Concern | Rule(s) |
|---|---|
| Type escape hatches | `@typescript-eslint/no-explicit-any`, `no-unsafe-assignment` / `-call` / `-member-access` / `-return` / `-argument`, `ban-ts-comment` (allow `@ts-expect-error` only with a description), `no-non-null-assertion`, `consistent-type-assertions` (`assertionStyle: 'never'` for objects if feasible) |
| Promises | `no-floating-promises`, `no-misused-promises`, `require-await`, `return-await` (`in-try-catch`), `await-thenable` |
| Control flow | `eqeqeq`, `curly: all`, `default-case`, `no-fallthrough`, `@typescript-eslint/switch-exhaustiveness-check`, `max-depth: 3`, `no-else-return`, `no-lonely-if` |
| Size/complexity (warnings that agents must justify) | `max-lines-per-function` ~40 (skip tests), `complexity` ~10, `max-params` 4 |
| Errors | `@typescript-eslint/only-throw-error`, `prefer-promise-reject-errors`, `no-empty` (no empty catch), `use-unknown-in-catch-callback-variable` |
| Hygiene | `no-console`, `no-debugger`, `no-eval`, `no-implied-eval`, `no-new-func`, `no-var`, `prefer-const`, `no-param-reassign` (props: true in `domain/`), `@typescript-eslint/no-unused-vars` (with `_` prefix ignore) |
| Naming | `@typescript-eslint/naming-convention`: camelCase vars/functions, PascalCase types, UPPER_SNAKE for top-level constants, no `I` prefix on interfaces |
| Types/exports | `@typescript-eslint/explicit-module-boundary-types` (return types on exports), `consistent-type-imports`, `consistent-type-definitions: interface` only where it fits — prefer to leave this off rather than fight unions |
| Imports | `import/no-cycle`, `import/order` (builtin → external → internal → relative, blank lines between), `import/no-default-export` (except config files), `n/prefer-node-protocol` |
| Security (see `security-secrets`) | `eslint-plugin-security` (`detect-object-injection` is noisy — enable the others: `detect-unsafe-regex`, `detect-non-literal-fs-filename`, `detect-child-process`, `detect-eval-with-expression`, `detect-non-literal-require`) |
| Enums | `no-restricted-syntax` on `TSEnumDeclaration` — closed sets are `as const` objects |

### Layer boundaries

Make the hexagonal dependency rule a lint error, not a convention. With `no-restricted-imports` (or `eslint-plugin-boundaries` / dependency-cruiser):

- Files under `src/domain/**` may import only from `src/domain/**` and `zod`/`packages/shared` types.
- Files under `src/app/**` may not import `express`, `pg`, `undici`/`node-fetch`, or anything under `src/adapters/**` or `src/http/**`; also not use global `fetch` (add `no-restricted-globals: ['error', 'fetch']` for `domain/` and `app/`).
- Files under `src/ports/**` import only types.
- `process.env` is restricted everywhere except `src/config.ts` (`n/no-process-env`).

### Prettier

`singleQuote: true`, `semi: true`, `trailingComma: 'all'`, `printWidth: 100`, 2-space indent, LF line endings (`.gitattributes` with `* text=auto eol=lf` so Windows checkouts don't produce whole-file diffs). The format-on-edit hook applies it; don't hand-format.

## Scripts

`npm run typecheck` (`tsc --noEmit` — Vitest does **not** type-check), `npm run lint`, `npm test`, `npm run build`. The Stop hook and CI run the same commands, so "works on my machine" and "works in the pipeline" are the same statement.

Add `npm audit --omit=dev --audit-level=high` to the pre-deploy checklist (see `security-secrets`).
