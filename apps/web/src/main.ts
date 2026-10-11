import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch(() => {
  document.body.textContent = 'The dashboard could not start. Reload the page to try again.';
});
