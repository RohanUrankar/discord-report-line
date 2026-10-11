---
name: state-management
description: Signals-based state management for the Angular 21 dashboard — separating server state from UI state, feature stores built on signal/computed (or NgRx SignalStore if the architect chose it), loading/error/data modelling, the live command log via polling with cursors (or SSE), pausing on hidden tabs, deduping and capping lists, optimistic config updates with rollback and version conflicts, URL-as-state for filters, and auth/session state. Use this whenever you add data fetching, a store or service holding state, live updates, filters, forms that save to the API, or when a component starts juggling multiple subscriptions, flags or duplicated data.
---

# State management (signals)

## Three kinds of state — keep them apart

| Kind | Example | Owner |
|---|---|---|
| **Server state** | command log, guild config, failures | a feature store that fetches, caches, refreshes |
| **URL state** | selected server, filters, expanded row id | router query params (source of truth), read via `toSignal` / `input()` binding |
| **Local UI state** | dialog open, form dirty, "3 new" pill | the component (`signal()` in the component) |

Most state bugs come from copying server or URL state into a component's local signal and letting the copies drift. Derive with `computed` instead of copying.

## Store pattern

Use a plain injectable store per feature (unless the ADR picked NgRx SignalStore — then follow its conventions with the same principles):

```ts
type Status = 'idle' | 'loading' | 'loaded' | 'error';

@Injectable({ providedIn: 'root' })
export class CommandLogStore {
  private readonly api = inject(ApiClient);

  private readonly _items = signal<InteractionRow[]>([]);
  private readonly _status = signal<Status>('idle');
  private readonly _error = signal<AppError | null>(null);

  readonly items = this._items.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isEmpty = computed(() => this._status() === 'loaded' && this._items().length === 0);
  readonly failedCount = computed(() => this._items().filter(i => i.outcome === 'failed').length);

  async load(guildId: string) { /* set loading, fetch, set items or error */ }
}
```

- Writable signals private; expose `asReadonly()` and `computed`. Components call intent methods (`load`, `saveRule`), never `.set()` on store state.
- Model status explicitly (not `isLoading` + `hasError` + `data` booleans that can contradict each other). Keep the last good data when a refresh fails, so the error state can be "partial".
- `resource()`/`httpResource()` are fine for simple read-only fetches *if* they're stable in the installed version (check Context7); stores are clearer when you need polling, merging, or optimistic writes.
- Never put secrets or session tokens in a store; the session is an httpOnly cookie and the store only knows `{ user, status }`.

## Live command log

The design ships polling in Step 4 and makes SSE an optional Step 6 toggle (F-13) — build polling first, behind a `LiveFeed` service interface so SSE can replace it without touching components.

**Polling (works on any host, including serverless):**
- Initial load: newest 50. Then every ~5s: `GET …/interactions?after=<newestId>`; merge by id (updates to existing rows replace them — a row's status changes as jobs complete).
- Also refresh rows still in a non-terminal state (`pending`/`retrying`), or have the API return changed rows since a `updatedAfter` cursor — otherwise "Mirrored ⏳" never turns into ✓.
- Pause when `document.visibilityState === 'hidden'`; refresh immediately on return. Back off (5s → 10s → 30s) on consecutive errors and show a quiet "Live updates paused — retrying" indicator, not an error toast every 5s.
- Cap the in-memory list (e.g. 500 rows); older rows are fetched by "Load more" with `before=<oldestId>`.

**SSE (if chosen):** an `EventSource` in a service, converted to a signal; reconnect handling with `Last-Event-ID`; fall back to polling on repeated failures. Remember it needs a long-lived connection — check it fits the hosting ADR.

New rows while the admin is scrolled/expanded go to a `pendingNew` signal (shown as the "N new" pill) instead of being merged into the visible list — see `ux-accessibility`.

## Saving config (optimistic with rollback)

```
save(rule):
  previous = current snapshot
  apply change locally (UI updates instantly, card shows "Saving…")
  PUT with version/etag
  ├─ ok      → replace with server response (server is the source of truth), toast "Saved"
  ├─ 409     → restore previous, reload latest, tell admin "Someone else changed this — reloaded latest"
  └─ error   → restore previous, keep the form values so the admin doesn't lose input, show error + Retry
```

Disable double-submit while a save is in flight; don't disable the form before the first attempt.

## Auth state

`AuthStore` with `status: 'unknown' | 'authenticated' | 'anonymous'` and `user`. On app start call `GET /api/auth/me` once; the `authGuard` waits for `unknown` to resolve before deciding (prevents a flash of the login page on refresh). The error interceptor sets `anonymous` on 401.

## Selected server (multi-guild)

The selected guild id lives in the route (`/servers/:guildId/log`). Stores take it as a parameter or react to it via an `effect` that reloads; when it changes, reset per-guild state so data from server A never renders under server B.

## Anti-patterns

- `subscribe()` inside components to copy values into fields.
- Effects that write to other signals to "sync" them — use `computed` (or `linkedSignal` if stable and truly needed).
- Global "app state" bag holding everything.
- Re-fetching the whole log every tick.
