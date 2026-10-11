import { Injector, inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { ConfirmDialogData } from '../../shared/ui/confirm-dialog';

/** Implemented by pages with a form that can hold edits not yet saved. */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

const LEAVE_DIALOG: ConfirmDialogData = {
  title: 'Leave without saving?',
  message: 'You have changes that are not saved. If you leave now, they are lost.',
  confirmLabel: 'Leave',
  cancelLabel: 'Keep editing',
};

/**
 * Asks before leaving a page with unsaved edits. The dialog code is loaded only when it is needed, so the
 * route table (which imports this guard) does not pull Material's dialog into the first download.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (page) => {
  if (!page.hasUnsavedChanges()) {
    return true;
  }
  const injector = inject(Injector);
  const [{ MatDialog }, { ConfirmDialog }] = await Promise.all([
    import('@angular/material/dialog'),
    import('../../shared/ui/confirm-dialog'),
  ]);
  const dialog = injector
    .get(MatDialog)
    .open<InstanceType<typeof ConfirmDialog>, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: LEAVE_DIALOG,
    });
  return (await firstValueFrom(dialog.afterClosed())) === true;
};
