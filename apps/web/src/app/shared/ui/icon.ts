import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ICON_PATHS, type IconName } from './icons';

/**
 * Decorative icon. It is always paired with visible text or an `aria-label` on its button, so it is hidden
 * from assistive technology (WCAG: never the only carrier of meaning).
 */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
      width: 1.25em;
      height: 1.25em;
      flex: none;
      vertical-align: middle;
    }
    svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
  `,
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      @for (d of paths(); track d) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
})
export class AppIcon {
  readonly name = input.required<IconName>();
  protected readonly paths = computed<readonly string[]>(() => ICON_PATHS[this.name()]);
}
