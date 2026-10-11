import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { SNACKBAR_SUCCESS_MS } from '../constants/app.constants';

/**
 * The one snackbar (user-facing-messages): outcomes of the admin's own actions. Success disappears by itself;
 * a failure stays until dismissed. Material's live announcer reads both, so nothing here announces twice.
 */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, undefined, { duration: SNACKBAR_SUCCESS_MS });
  }

  failure(message: string): void {
    this.snackBar.open(message, 'Dismiss');
  }
}
