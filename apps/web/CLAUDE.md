# apps/web

Angular 21 + Angular Material 3 admin dashboard: login, connect server, live command log with event timelines, command configuration, failures. Owned by the `frontend-implementer` agent.

- Conventions: `frontend-guidelines` skill. Data flow: `state-management`. Screens and a11y: `ux-accessibility`. Copy: `user-facing-messages`.
- Talks only to same-origin `/api` (dev proxy via `proxy.conf.json`); request/response types come from `packages/shared`.
- No secrets in `environment.ts` or anywhere in the bundle; sessions are httpOnly cookies.
- Commands (fill in once scaffolded): `npm start` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run build`.
- Scaffolding note: this folder already contains this file, so run `ng new` elsewhere and move the project in, or use `ng new web --directory apps/web` and keep this file.
