import type { ComponentFixture } from '@angular/core/testing';

/** The rendered root element of a fixture. */
export function root(fixture: ComponentFixture<unknown>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

export function query<T extends HTMLElement = HTMLElement>(
  fixture: ComponentFixture<unknown>,
  selector: string,
): T | null {
  return root(fixture).querySelector<T>(selector);
}

export function queryAll<T extends HTMLElement = HTMLElement>(
  fixture: ComponentFixture<unknown>,
  selector: string,
): T[] {
  return Array.from(root(fixture).querySelectorAll<T>(selector));
}

/** Collapsed visible text of the whole fixture (or of one element). */
export function textOf(target: ComponentFixture<unknown> | HTMLElement | null | undefined): string {
  const el =
    target === null || target === undefined
      ? null
      : target instanceof HTMLElement
        ? target
        : root(target);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Let promises and Angular's scheduled change detection settle. */
export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  await fixture.whenStable();
  await Promise.resolve();
  await fixture.whenStable();
}
