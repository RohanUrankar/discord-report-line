import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Router } from '@angular/router';

import { query, settle, textOf, type as typeInto } from '../../../testing/dom';
import { session } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { AppError } from '../../core/errors/app-error';
import { Login, signInErrorMessage } from './login';

const login = vi.fn();
const me = vi.fn();

function create(returnUrl?: string) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter([
        { path: 'login', children: [] },
        { path: '', pathMatch: 'full', children: [] },
        { path: 'g/:guildId/log', children: [] },
      ]),
      { provide: ApiClient, useValue: { login, me, logout: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(Login);
  if (returnUrl !== undefined) {
    fixture.componentRef.setInput('returnUrl', returnUrl);
  }
  fixture.detectChanges();
  return fixture;
}

const appError = (
  init: Partial<ConstructorParameters<typeof AppError>[0]> & { code: AppError['code'] },
) => new AppError({ message: 'm', status: 400, ...init });

describe('Login', () => {
  beforeEach(() => {
    login.mockReset();
    me.mockReset();
  });

  it('WHEN the form is submitted empty THE UI SHALL name what is missing and focus the first problem', async () => {
    const fixture = create();
    query<HTMLButtonElement>(fixture, 'button[type="submit"]')!.click();
    await settle(fixture);
    expect(textOf(fixture)).toContain('Enter your email address.');
    expect(textOf(fixture)).toContain('Enter your password.');
    expect(document.activeElement).toBe(query(fixture, 'input[type="email"]'));
    expect(login).not.toHaveBeenCalled();
  });

  it('WHEN the credentials are wrong THE UI SHALL show the shared message, keep the email and clear the password', async () => {
    login.mockRejectedValue(
      appError({
        code: 'INVALID_CREDENTIALS',
        status: 401,
        message: "That email and password don't match. Check them and try again.",
        requestId: 'req-77',
      }),
    );
    const fixture = create();
    typeInto(query<HTMLInputElement>(fixture, 'input[type="email"]')!, 'admin@example.test');
    typeInto(query<HTMLInputElement>(fixture, 'input[type="password"]')!, 'nope');
    query<HTMLButtonElement>(fixture, 'button[type="submit"]')!.click();
    await settle(fixture);

    const alert = query(fixture, '[role="alert"]');
    expect(textOf(alert)).toContain("That email and password don't match");
    expect(textOf(alert)).toContain('Reference: req-77');
    expect(query<HTMLInputElement>(fixture, 'input[type="email"]')!.value).toBe(
      'admin@example.test',
    );
    expect(query<HTMLInputElement>(fixture, 'input[type="password"]')!.value).toBe('');
    expect(document.activeElement).toBe(query(fixture, 'input[type="password"]'));
  });

  it('WHEN sign-in is rate limited THE UI SHALL show the exact wait from Retry-After', async () => {
    login.mockRejectedValue(appError({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 42 }));
    const fixture = create();
    typeInto(query<HTMLInputElement>(fixture, 'input[type="email"]')!, 'a@example.test');
    typeInto(query<HTMLInputElement>(fixture, 'input[type="password"]')!, 'x');
    query<HTMLButtonElement>(fixture, 'button[type="submit"]')!.click();
    await settle(fixture);
    expect(textOf(query(fixture, '[role="alert"]'))).toContain(
      'Too many attempts. Try again in 42 seconds.',
    );
  });

  it('WHEN sign-in succeeds with a safe return URL THE UI SHALL go there', async () => {
    login.mockResolvedValue(session());
    const fixture = create('/g/111111111111111111/log');
    const router = TestBed.inject(Router);
    typeInto(query<HTMLInputElement>(fixture, 'input[type="email"]')!, 'a@example.test');
    typeInto(query<HTMLInputElement>(fixture, 'input[type="password"]')!, 'pw');
    query<HTMLButtonElement>(fixture, 'button[type="submit"]')!.click();
    await settle(fixture);
    await vi.waitFor(() => {
      expect(router.url).toBe('/g/111111111111111111/log');
    });
  });

  it('WHEN the return URL points off-site THE UI SHALL ignore it and open the dashboard', async () => {
    login.mockResolvedValue(session());
    const fixture = create('//evil.example/phish');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl');
    typeInto(query<HTMLInputElement>(fixture, 'input[type="email"]')!, 'a@example.test');
    typeInto(query<HTMLInputElement>(fixture, 'input[type="password"]')!, 'pw');
    query<HTMLButtonElement>(fixture, 'button[type="submit"]')!.click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('WHEN the server could not be reached at page load THE UI SHALL say so and offer to try again', async () => {
    me.mockRejectedValue(appError({ code: 'NETWORK', status: 0 }));
    const fixture = create();
    const { AuthStore } = await import('../../core/auth/auth-store');
    await TestBed.inject(AuthStore).restore();
    fixture.detectChanges();
    expect(textOf(query(fixture, '[role="alert"]'))).toContain("can't reach the server");
    me.mockResolvedValue(session());
    const retry = Array.from(fixture.nativeElement.querySelectorAll('button')).find((b) =>
      (b as HTMLElement).textContent.includes('Try again'),
    ) as HTMLButtonElement;
    retry.click();
    await settle(fixture);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('signInErrorMessage uses the shared wording when no wait is known', () => {
    expect(
      signInErrorMessage(
        appError({
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Wait a moment and try again.',
        }),
      ),
    ).toBe('Too many attempts. Wait a moment and try again.');
  });
});
