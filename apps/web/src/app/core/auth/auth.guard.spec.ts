import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, type CanActivateFn, type RouterStateSnapshot } from '@angular/router';
import type { ActivatedRouteSnapshot } from '@angular/router';

import { errorBody, session } from '../../../testing/fixtures';
import { configureHttpTestbed } from '../../../testing/http-testbed';
import { authGuard, guestGuard } from './auth.guard';

function run(guard: CanActivateFn, url: string): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(() =>
    guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
  );
  return Promise.resolve(result as boolean | UrlTree | Promise<boolean | UrlTree>);
}

describe('route guards', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    http = configureHttpTestbed();
  });

  afterEach(() => {
    http.verify();
  });

  it('WHEN a signed-in admin opens a page THE authGuard SHALL let them in after asking /api/auth/me once', async () => {
    const decision = run(authGuard, '/g/1/log');
    http.expectOne('/api/auth/me').flush(session());
    expect(await decision).toBe(true);
    // a later navigation reuses the answer
    expect(await run(authGuard, '/connect')).toBe(true);
    http.expectNone('/api/auth/me');
  });

  it('WHEN there is no session THE authGuard SHALL send the visitor to sign-in, remembering a safe return path', async () => {
    const decision = run(authGuard, '/g/111111111111111111/log?filter=attention');
    http
      .expectOne('/api/auth/me')
      .flush(errorBody('UNAUTHENTICATED'), { status: 401, statusText: 'Unauthorized' });
    const result = await decision;
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe(
      '/login?returnUrl=%2Fg%2F111111111111111111%2Flog%3Ffilter%3Dattention',
    );
  });

  it('WHEN the requested URL is not a plain in-app path THE authGuard SHALL drop the return path', async () => {
    const decision = run(authGuard, '//evil.example');
    http
      .expectOne('/api/auth/me')
      .flush(errorBody('UNAUTHENTICATED'), { status: 401, statusText: 'Unauthorized' });
    expect(TestBed.inject(Router).serializeUrl((await decision) as UrlTree)).toBe('/login');
  });

  it('WHEN the server is down THE authGuard SHALL go to sign-in (which explains it) and ask again next time', async () => {
    const first = run(authGuard, '/');
    http.expectOne('/api/auth/me').error(new ProgressEvent('error'), { status: 0 });
    expect(await first).toBeInstanceOf(UrlTree);

    const second = run(authGuard, '/');
    http.expectOne('/api/auth/me').flush(session());
    expect(await second).toBe(true);
  });

  it('WHEN a signed-in admin opens the sign-in page THE guestGuard SHALL send them to the dashboard', async () => {
    const decision = run(guestGuard, '/login');
    http.expectOne('/api/auth/me').flush(session());
    const result = await decision;
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/');
  });

  it('WHEN nobody is signed in THE guestGuard SHALL show the sign-in page', async () => {
    const decision = run(guestGuard, '/login');
    http
      .expectOne('/api/auth/me')
      .flush(errorBody('UNAUTHENTICATED'), { status: 401, statusText: 'Unauthorized' });
    expect(await decision).toBe(true);
  });
});
