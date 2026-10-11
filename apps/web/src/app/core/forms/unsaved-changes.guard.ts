import { inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import { ConfirmDialog, type ConfirmDialogData } from '../../shared/ui/confirm-dialog';

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

export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (page) => {
  if (!page.hasUnsavedChanges()) {
    return true;
  }
  const dialog = inject(MatDialog).open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
    data: LEAVE_DIALOG,
  });
  return (await firstValueFrom(dialog.afterClosed())) === true;
};
