import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  TitleStrategy,
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';

import { routes } from './app.routes';
import { PageTitleStrategy } from './core/a11y/page-title.strategy';
import { csrfInterceptor } from './core/http/csrf.interceptor';
import { errorInterceptor } from './core/http/error.interceptor';

// Zoneless: no zone.js is loaded (it is neither a dependency nor in angular.json polyfills), so change
// detection runs from signals. Interceptor order matters: the CSRF header is added on the way out, and
// errors are mapped to AppError (and 401 handled) on the way back.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),
    { provide: TitleStrategy, useExisting: PageTitleStrategy },
    provideHttpClient(withInterceptors([csrfInterceptor, errorInterceptor])),
  ],
};
