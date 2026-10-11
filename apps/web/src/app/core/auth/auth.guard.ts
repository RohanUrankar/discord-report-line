import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';

import { RETURN_URL_PARAM, ROUTE } from '../constants/routes.constants';
import { AuthStore } from './auth-store';
import { safeReturnUrl } from './safe-return-url';

/** Everything except the sign-in page needs a session. Waits for the first "who am I" before deciding. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  if (auth.status() === 'unknown' || auth.status() === 'unavailable') {
    await auth.restore();
  }
  if (auth.isAuthenticated()) {
    return true;
  }
  const returnUrl = safeReturnUrl(state.url);
  return router.createUrlTree([ROUTE.login], {
    queryParams: returnUrl === null ? {} : { [RETURN_URL_PARAM]: returnUrl },
  });
};

/** The sign-in page is for people who are not signed in; someone with a session goes to the dashboard. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  if (auth.status() === 'unknown') {
    await auth.restore();
  }
  return auth.isAuthenticated() ? router.createUrlTree([ROUTE.home]) : true;
};
