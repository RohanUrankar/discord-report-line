---
name: frontend-guidelines
description: Coding conventions for the Angular 21 dashboard in apps/web — standalone components, signals, zoneless change detection, new control flow, OnPush, inject(), feature-based folder layout with lazy routes, component design (one concern, small inputs), the typed API client and HTTP interceptors (auth, errors, request id), frontend security rules (no bypassSecurityTrust, no browser-stored tokens), error display, constants, performance, Angular Material 3 theming and component usage, forms, and testing with Vitest. Use this whenever you create or modify anything under apps/web — components, services, routes, guards, interceptors, styles, forms or tests — or need to decide where frontend code belongs or which Angular API to use.
---

# Frontend guidelines (apps/web)

The dashboard is small: login, connect a server, live command log with event timelines, command configuration, failures view. Keep it boring and consistent so the graders' attention goes to the integration, not to a fight with the framework.

## Verify before you write

Angular moves fast and training data lags. Before using any API you aren't certain is stable in the installed version (e.g. `httpResource`, `resource`, signal forms, `linkedSignal`, Material theming mixins), check Context7 `/websites/angular_dev` (and Angular Material docs) and the installed `package.json` version. Prefer stable APIs; if you use a developer-preview one, isolate it behind a small service and note it in your report. Log any surprises with `ai-journal`.

## Baseline (Angular 21)

- Standalone components only (no NgModules). Don't write `standalone: true` — it's the default.
- Zoneless change detection (default for new apps — confirm in `app.config.ts`); state lives in signals so the view updates without zone.js.
- `changeDetection: ChangeDetectionStrategy.OnPush` on every component anyway — it documents intent and catches mutation bugs.
- `input()`, `output()`, `model()`, `viewChild()` signal APIs instead of decorators.
- `inject()` instead of constructor parameters.
- Built-in control flow `@if`, `@for (…; track item.id)`, `@switch`, `@defer` — no `*ngIf`/`*ngFor`.
- Typed reactive forms (stable). Use signal forms only if the architect chose them and the installed version marks them stable.
- Vitest is the default unit runner for new projects — use it with `TestBed`.
- Strict TypeScript and strict templates on.

## Layout

```
apps/web/src/app/
  app.config.ts            # providers: router, http (withInterceptors), animations, zoneless
  app.routes.ts            # top-level routes; features lazy-loaded with loadChildren/loadComponent
  core/
    api/                   # ApiClient + typed endpoint functions (types from packages/shared)
    auth/                  # AuthStore, authGuard, login page
    http/                  # interceptors: credentials, request-id, error → AppError
    errors/                # global ErrorHandler, error → message mapping
    layout/                # shell: toolbar, side nav, server switcher
  shared/
    ui/                    # dumb presentational components: status-chip, empty-state, relative-time, confirm-dialog
  features/
    servers/               # connect server flow, channel picker
    command-log/           # live log table, event timeline, filters
    command-config/        # rules editor per command
    failures/              # dead jobs, retry history
  styles/                  # theme.scss, tokens
```

Rules: features don't import from each other (shared code moves to `shared/` or `core/`); `shared/ui` components take inputs and emit outputs, no services; only `core/api` talks to `HttpClient`.

## Components

- Smart (route-level, injects stores) vs presentational (`shared/ui`, inputs/outputs only).
- Templates read signals, never call methods that compute (use `computed`).
- Keep components under ~150 lines; extract when a template grows sub-sections with their own state.
- Use `@defer (on viewport)` for heavy, below-the-fold sections (e.g. event timeline details).
- **One component = one UI concern.** If describing it needs "and", split it. Extend through new components or inputs rather than bolting modes onto a shared one; keep inputs few and focused — don't make consumers pass props they never use.
- Depend on injected services (`ApiClient`, stores, `NotifyService`), never construct collaborators or call `HttpClient` directly in a component, so tests can swap them.
- Every interactive element is a real `<button>`/`<a>`/form control (or a Material component) with an accessible name; icon-only buttons have `aria-label`. Full rules in `ux-accessibility`.

## Security in the browser

Everything in the bundle is public and everything rendered may be attacker-supplied (a Discord user typed that report text).

- Render user text with interpolation (`{{ }}`) only. No `[innerHTML]`, and no `bypassSecurityTrustHtml/Url/Script/ResourceUrl` — if you think you need one, raise a proposal; the answer is almost always "format it in the template".
- Never build URLs from user text (`href`/`src` bound to report content). If a link is genuinely needed, allow only `https:` and render via an `<a>` with `rel="noopener noreferrer"`.
- No tokens, session ids or secrets in `localStorage`/`sessionStorage`/IndexedDB or `environment.ts`; the session lives in the HttpOnly cookie, the SPA only holds "logged in as X" in memory. Non-sensitive UI prefs (theme, density, filters) may use `localStorage` inside a try/catch.
- Client-side validation is for UX only; the backend remains authoritative. Don't encode business or authorisation rules in the UI — hiding a button is not access control.
- The CSRF header is added by one interceptor, not hand-written per call. No third-party scripts, fonts or analytics loaded from a CDN without a reason and (for scripts) integrity attributes.

## Errors shown to users

- Components never see raw `HttpErrorResponse`s: the error interceptor maps them to `{ code, message, details, requestId }`; the UI picks wording from the shared code→message map (`user-facing-messages`), shows it via the `NotifyService` snackbar or an inline `mat-error`/banner with a retry action where one makes sense, and never shows stack traces, SQL, status internals or hostnames.
- Showing the `requestId` in a small, copyable "Reference" line is fine and helps support; the technical detail stays in the console/logs.
- Every async view handles four states (loading, empty, error with retry, data) — `ux-accessibility` and `state-management` describe how.
- Subscriptions: prefer signals/`toSignal`/`resource`; otherwise `takeUntilDestroyed()`. A leaked polling subscription on a free-tier backend is a real cost.

## Constants and performance

- No magic numbers or strings in components: poll interval, page size, debounce, snackbar duration, breakpoint widths, route paths live in `core/constants/` (or a feature's `*.constants.ts`) with names that say what they are.
- Lazy-load every feature route (`loadComponent`/`loadChildren`); keep the initial bundle small — the dashboard is served from a free-tier host and opened on cold caches. Import only the Material modules/components you use; avoid pulling a utility library for one function.
- `@for` always has a `track` expression keyed on a stable id; derived values are `computed()`, not template method calls; no heavy work in templates.
- Check bundle size after adding a dependency (`ng build` budgets in `angular.json` should fail the build if the initial bundle grows past the chosen limit).

## API client and HTTP

- Requests go to a same-origin `/api` (dev: `proxy.conf.json` to the local API) — no hard-coded hosts, no secrets in `environment.ts`.
- `withCredentials: true` via interceptor for cookie sessions.
- Error interceptor converts `HttpErrorResponse` into `{ code, message, details, requestId }` (shape from the `resilience` skill); on `401`/`SESSION_EXPIRED` → clear auth state and navigate to `/login?returnUrl=…`.
- Request/response types come from `packages/shared` (same zod schemas the backend validates with). Don't hand-write duplicate interfaces.

## Angular Material 3

- One theme in `styles/theme.scss` using the M3 `mat.theme(...)` mixin (verify exact mixin/options for the installed version) with a primary palette, typography, and density. Support light + dark via `color-scheme`.
- Enable strong focus indicators (`mat.strong-focus-indicators`) for keyboard users.
- Use Material components as-is before styling them: `mat-table` (+ `MatSort`, `MatPaginator` or infinite scroll), `mat-chip` for status, `mat-expansion-panel` for timelines, `mat-stepper` for connect-server, `mat-snack-bar` via one `NotifyService`, `mat-dialog` for confirmations, `mat-form-field` with `mat-error`.
- Custom styling uses CSS custom properties / design tokens exposed by the theme, not deep selectors or `::ng-deep`.
- Icons: Material Symbols, always with text or `aria-label`.

## Testing

- Unit-test stores and pure functions (filters, mappers, status → label).
- Component tests for meaningful behaviour (renders empty state, shows error with retry, disables save while saving) with `TestBed` + harnesses from `@angular/cdk/testing` for Material components.
- Every new component/service/store gets tests for the success path **and** the error path; form components also test each validation state (required, too long, server-side field error) and that submit is blocked while invalid or saving; stores test state transitions (loading → data, loading → error, optimistic update → rollback).
- Mock the API at the `ApiClient` boundary, using fixtures that match `packages/shared` schemas. For the `ApiClient`/interceptor tests themselves use `provideHttpClient()` + `provideHttpClientTesting()` and `HttpTestingController` (not the deprecated `HttpClientTestingModule` — confirm for the installed version).
- Test the security-relevant behaviour: a `<script>` string in a report renders as text; a 401 clears auth state and redirects; the CSRF header is sent on mutations.
- Avoid snapshot tests.

## Style

- File names `kebab-case.ts`, one component per file, selectors prefixed `app-`.
- No `any`, no `subscribe` without cleanup — prefer signals/`toSignal`, or `takeUntilDestroyed()`.
- No business rules in components — the backend decides; the frontend displays and edits config.
- Conventional commits: `feat(web): …`.
