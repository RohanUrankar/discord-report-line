import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { NowClock } from './now-clock';
import { absoluteTime, relativeTime } from '../../shared/format/time';

/** A time as "2 min ago" with the exact local time on hover and for assistive technology. */
@Component({
  selector: 'app-time',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<time [attr.datetime]="value()" [attr.title]="absolute()">{{ relative() }}</time>`,
})
export class RelativeTime {
  private readonly clock = inject(NowClock);

  readonly value = input.required<string>();
  protected readonly relative = computed(() =>
    relativeTime(Date.parse(this.value()), this.clock.now()),
  );
  protected readonly absolute = computed(() => absoluteTime(this.value()));
}
