import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { AuthStore } from '../auth/auth-store';
import { API_PREFIX, CSRF_HEADER_NAME } from '../constants/app.constants';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The single place the CSRF header is added: every API request that is not a read carries the token the
 * server gave us at login / session restore. The token lives in memory only (AuthStore).
 */
export const csrfInterceptor: HttpInterceptorFn = (req, next) => {
  if (SAFE_METHODS.has(req.method) || !req.url.startsWith(API_PREFIX)) {
    return next(req);
  }
  const token = inject(AuthStore).csrfToken();
  return next(token === null ? req : req.clone({ setHeaders: { [CSRF_HEADER_NAME]: token } }));
};
