# apps/api

Express 5 + TypeScript backend: the Discord interactions endpoint, outbox worker, integrations, and the admin JSON API the dashboard uses. Owned by the `backend-implementer` agent.

- Conventions: `backend-guidelines` skill. Discord specifics: `discord-interactions`. Failures/retries: `resilience`. Secrets/auth: `security-secrets`. Logs + event history: `observability`.
- `src/app.ts` builds the app without listening (tests import it); `src/main.ts` only bootstraps.
- `src/config/env.ts` is the only reader of `process.env`; every downstream base URL and timeout is configurable so the quality verifier can point them at `stub-downstream.mjs`.
- The interactions route uses a raw-body parser and must stay mounted before any JSON parser.
- Tests sign their own requests with a test Ed25519 key (see `test/helpers/`); never call real Discord/Slack/LLM in tests.
- Commands (fill in once scaffolded): `npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run db:migrate`.
