import type { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/auth/auth.guard';

// Every feature is lazy: the first paint (sign-in) loads only the shell of the app. Parameters are inherited
// by child routes (see app.config), so any page under /g/:guildId can read `guildId` as an input.
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in',
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./core/layout/shell').then((m) => m.Shell),
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Your servers',
        loadComponent: () => import('./features/servers/landing').then((m) => m.Landing),
      },
      {
        path: 'connect',
        title: 'Connect a server',
        loadComponent: () =>
          import('./features/servers/connect-server').then((m) => m.ConnectServer),
      },
      {
        path: 'g/:guildId',
        loadComponent: () => import('./core/layout/guild-layout').then((m) => m.GuildLayout),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'log' },
          {
            path: 'log',
            title: 'Command log',
            loadComponent: () => import('./features/command-log/log-page').then((m) => m.LogPage),
          },
          {
            path: 'log/:interactionId',
            title: 'Command details',
            loadComponent: () =>
              import('./features/command-log/interaction-detail').then(
                (m) => m.InteractionDetailPage,
              ),
          },
        ],
      },
      {
        path: '**',
        title: 'Page not found',
        loadComponent: () => import('./core/layout/not-found').then((m) => m.NotFound),
      },
    ],
  },
];
