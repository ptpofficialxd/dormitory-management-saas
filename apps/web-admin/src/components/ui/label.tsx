import { cn } from '@/lib/utils';
import * as LabelPrimitive from '@radix-ui/react-label';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';

/**
 * Label — wraps `@radix-ui/react-label` so `htmlFor` propagates through the
 * Radix form primitives and the a11y "label must be associated with an input"
 * lint passes. Using Radix matches the shadcn upstream and plays nicely with
 * react-hook-form's `FormField` when we wire it in Task #58.
 */
export const Label = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
