import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { CSRF, GUILD_A, errorBody, session } from '../../../testing/fixtures';
import { configureHttpTestbed } from '../../../testing/http-testbed';
import { ApiClient } from '../api/api-client';
import { AppError } from '../errors/app-error';
import { AuthStore } from './auth-store';

describe('auth, CSRF and 401 handling (real interceptors, HTTP testing backend)', () => {
  let http: HttpTestingController;
  let auth: AuthStore;
  let api: ApiClient;
  let router: Router;

  beforeEach(() => {
    http = configureHttpTestbed();
    auth = TestBed.inject(AuthStore);
    api = TestBed.inject(ApiClient);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    http.verify();
  });

  async function signIn(): Promise<void> {
    const restoring = auth.restore();
    http.expectOne('/api/auth/me').flush(session());
    await restoring;
  }

  it('WHEN the app loads THE UI SHALL restore the session from GET /api/auth/me', async () => {
    const restoring = auth.restore();
    const req = http.expectOne('/api/auth/me');
    expect(req.request.method).toBe('GET');
    req.flush(session());
    await restoring;
    expect(auth.status()).toBe('authenticated');
    expect(auth.admin()?.email).toBe('admin@example.test');
    expect(auth.csrfToken()).toBe(CSRF);
  });

  it('shares one in-flight restore between callers', async () => {
    const first = auth.restore();
    const second = auth.restore();
    http.expectOne('/api/auth/me').flush(session());
    await Promise.all([first, second]);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('WHEN there is no session THE UI SHALL become anonymous without redirecting by itself', async () => {
    const navigate = vi.spyOn(router, 'navigate');
    const restoring = auth.restore();
    http
      .expectOne('/api/auth/me')
      .flush(errorBody('UNAUTHENTICATED'), { status: 401, statusText: 'Unauthorized' });
    await restoring;
    expect(auth.status()).toBe('anonymous');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('WHEN the server is down at page load THE UI SHALL say it is unavailable, not signed out', async () => {
    const restoring = auth.restore();
    http.expectOne('/api/auth/me').error(new ProgressEvent('error'), { status: 0 });
    await restoring;
    expect(auth.status()).toBe('unavailable');
  });

  it('WHEN a request is not a GET THE UI SHALL send the CSRF token in X-CSRF-Token', async () => {
    await signIn();
    const connecting = api.connectGuild(GUILD_A);
    const req = http.expectOne('/api/guilds');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('X-CSRF-Token')).toBe(CSRF);
    req.flush({ id: GUILD_A, name: null });
    await connecting;
  });

  it('sends the token on PUT and on logout too', async () => {
    await signIn();
    const saving = api.updateSettings(GUILD_A, { postChannelId: null });
    const put = http.expectOne(`/api/guilds/${GUILD_A}/settings`);
    expect(put.request.headers.get('X-CSRF-Token')).toBe(CSRF);
    put.flush({ postChannelId: null, mirrorConfigured: false });
    await saving;

    const out = auth.logout();
    const post = http.expectOne('/api/auth/logout');
    expect(post.request.headers.get('X-CSRF-Token')).toBe(CSRF);
    post.flush(null, { status: 204, statusText: 'No Content' });
    await out;
    expect(auth.status()).toBe('anonymous');
    expect(auth.csrfToken()).toBeNull();
  });

  it('WHEN a request is a GET THE UI SHALL NOT send the CSRF header', async () => {
    await signIn();
    const loading = api.listGuilds();
    const req = http.expectOne('/api/guilds');
    expect(req.request.headers.has('X-CSRF-Token')).toBe(false);
    req.flush({ items: [] });
    await loading;
  });

  it('WHEN any call comes back 401 UNAUTHENTICATED THE UI SHALL clear the session and go to sign-in', async () => {
    await signIn();
    await router.navigateByUrl(`/g/${GUILD_A}/log?filter=attention`);
    const loading = api.listGuilds();
    http
      .expectOne('/api/guilds')
      .flush(errorBody('UNAUTHENTICATED'), { status: 401, statusText: 'Unauthorized' });
    await expect(loading).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await vi.waitFor(() => {
      expect(router.url).toContain('/login');
    });
    expect(auth.status()).toBe('anonymous');
    expect(auth.admin()).toBeNull();
    expect(auth.csrfToken()).toBeNull();
    expect(router.url).toContain('/login');
    expect(router.url).toContain('returnUrl=%2Fg%2F');
  });

  it('WHEN sign-in fails with wrong credentials THE UI SHALL surface INVALID_CREDENTIALS and NOT treat it as an expired session', async () => {
    const navigate = vi.spyOn(router, 'navigate');
    const logging = auth.login('admin@example.test', 'wrong');
    http
      .expectOne('/api/auth/login')
      .flush(errorBody('INVALID_CREDENTIALS'), { status: 401, statusText: 'Unauthorized' });
    await expect(logging).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('WHEN sign-in is rate limited THE UI SHALL carry the exact Retry-After wait', async () => {
    const logging = auth.login('admin@example.test', 'x');
    http.expectOne('/api/auth/login').flush(errorBody('RATE_LIMITED'), {
      status: 429,
      statusText: 'Too Many',
      headers: { 'Retry-After': '42' },
    });
    const error = await logging.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      requestId: 'req-1234',
    });
  });

  it('WHEN sign-in succeeds THE UI SHALL keep the session in memory', async () => {
    const logging = auth.login('admin@example.test', 'pw');
    const req = http.expectOne('/api/auth/login');
    expect(req.request.body).toEqual({ email: 'admin@example.test', password: 'pw' });
    req.flush(session());
    await logging;
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('WHEN sign-out cannot reach the server THE UI SHALL stay signed in and say why', async () => {
    await signIn();
    const out = auth.logout();
    http.expectOne('/api/auth/logout').error(new ProgressEvent('error'), { status: 0 });
    await expect(out).rejects.toMatchObject({ code: 'NETWORK' });
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('WHEN a reply does not match the contract THE UI SHALL fail as one generic error', async () => {
    const loading = api.listGuilds();
    http.expectOne('/api/guilds').flush({ items: [{ id: 'not-a-snowflake', name: null }] });
    await expect(loading).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('WHEN any of this happens THE UI SHALL NOT touch localStorage, sessionStorage or cookies', async () => {
    const touched: string[] = [];
    const watched = (name: string): Storage =>
      new Proxy({} as Storage, {
        get: (_target, prop) => {
          touched.push(`${name}.${String(prop)}`);
          return undefined;
        },
        set: (_target, prop) => {
          touched.push(`${name}.${String(prop)}=`);
          return true;
        },
      });
    vi.stubGlobal('localStorage', watched('localStorage'));
    vi.stubGlobal('sessionStorage', watched('sessionStorage'));
    const cookieSet = vi.spyOn(document, 'cookie', 'set');

    await signIn();
    const connecting = api.connectGuild(GUILD_A);
    http.expectOne('/api/guilds').flush({ id: GUILD_A, name: null });
    await connecting;
    const out = auth.logout();
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await out;

    expect(touched).toEqual([]);
    expect(cookieSet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
