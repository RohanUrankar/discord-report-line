import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { AuthStore } from '../auth/auth-store';
import { API_BASE } from '../constants/app.constants';
import { isUnauthenticated } from '../errors/app-error';
import { toAppError } from './error-mapper';

/**
 * Calls whose 401 is an expected answer, not an expired session: restoring the session on page load, and
 * signing in. Those callers handle it themselves; everything else going 401 ends the session.
 */
const OWN_401_URLS: readonly string[] = [`${API_BASE}/auth/me`, `${API_BASE}/auth/login`];

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthStore);
  return next(req).pipe(
    catchError((failure: unknown) => {
      if (!(failure instanceof HttpErrorResponse)) {
        return throwError(() => failure);
      }
      const error = toAppError(failure);
      if (isUnauthenticated(error) && !OWN_401_URLS.includes(req.url)) {
        auth.expire();
      }
      return throwError(() => error);
    }),
  );
};
