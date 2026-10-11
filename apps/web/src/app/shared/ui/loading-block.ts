import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Skeleton rows in the shape of the content, so nothing jumps when it arrives. Static under reduced motion. */
@Component({
  selector: 'app-loading-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    .line {
      height: 44px;
      margin-bottom: 8px;
      border-radius: var(--mat-sys-corner-small);
      background: linear-gradient(
        90deg,
        var(--mat-sys-surface-container) 25%,
        var(--mat-sys-surface-container-high) 50%,
        var(--mat-sys-surface-container) 75%
      );
      background-size: 200% 100%;
      animation: shimmer 1.4s linear infinite;
    }
    @keyframes shimmer {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .line {
        animation: none;
      }
    }
  `,
  template: `
    <div role="status">
      <span class="sr-only">{{ label() }}</span>
      <div aria-hidden="true">
        @for (n of rows(); track n) {
          <div class="line"></div>
        }
      </div>
    </div>
  `,
})
export class LoadingBlock {
  readonly label = input('Loading');
  readonly lines = input(4);
  protected readonly rows = computed(() => Array.from({ length: this.lines() }, (_, i) => i));
}
