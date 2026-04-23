import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * `cn` — class-name composer used by every shadcn-style component.
 *
 * `clsx` handles conditional/array/object class lists, then `tailwind-merge`
 * dedupes conflicting Tailwind utilities (e.g. `px-4 px-6` → `px-6`). Without
 * the merge step, the order matters and overrides break unpredictably.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
