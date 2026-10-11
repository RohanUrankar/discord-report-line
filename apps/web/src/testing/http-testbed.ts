import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';

import { csrfInterceptor } from '../app/core/http/csrf.interceptor';
import { errorInterceptor } from '../app/core/http/error.interceptor';

/** Routes that exist only so navigation in tests has somewhere to land. */
export const TEST_ROUTES: Routes = [
  { path: 'login', children: [] },
  { path: 'connect', children: [] },
  { path: 'g/:guildId/log', children: [] },
  { path: 'g/:guildId/log/:interactionId', children: [] },
  { path: '', pathMatch: 'full', children: [] },
];

/**
 * The real interceptors on top of the HTTP testing backend, so tests exercise the same chain the app runs
 * (CSRF header out, AppError mapping and 401 handling back).
 */
export function configureHttpTestbed(
  extra: Provider[] = [],
  routes: Routes = TEST_ROUTES,
): HttpTestingController {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([csrfInterceptor, errorInterceptor])),
      provideHttpClientTesting(),
      provideRouter(routes),
      ...extra,
    ],
  });
  return TestBed.inject(HttpTestingController);
}
