"use client";

// shadcn/ui Button, themed through the §1 tokens (§4.6: override via CSS vars,
// do not edit component internals).
//
// The size scale starts at 44px, not at shadcn's default 36px. §4.2 and §6 both
// require a 44px touch target, and a "sm" that is 36px would mean every call
// site has to remember to opt out of the default — the wrong way round.

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill " +
    "font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    // §7 disabled-states: opacity plus a cursor change, and `disabled` is the
    // real attribute so it is announced rather than merely looking inert.
    "disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // §4: one primary CTA per surface. Ink pill, white text (17:1). Paired with a
        // ghost/outline pill on the same row (Steep).
        //
        // The disabled treatment is a neutral outline rather than a faded fill: a
        // half-strength ink fill reads as a different colour, not as a control waiting
        // for input.
        primary:
          "bg-action text-on-action hover:opacity-85 active:opacity-70 " +
          "disabled:bg-transparent disabled:opacity-100 disabled:border disabled:border-outline-strong " +
          "disabled:text-ink-invert-muted",
        // On the app background.
        outline:
          "border border-outline-strong bg-transparent text-ink-invert hover:bg-ink-invert/[0.08]",
        // On a white card. `on-surface` no longer retunes anything (globals.css).
        outlineInk:
          "on-surface border border-outline-ink bg-transparent text-ink hover:bg-ink-invert/[0.08]",
        ghost: "bg-transparent text-ink-invert-muted hover:bg-ink-invert/[0.08] hover:text-ink-invert",
        ghostInk: "on-surface bg-transparent text-ink-muted hover:bg-ink-invert/[0.08] hover:text-ink",
        // §7: destructive actions carry the danger colour and are separated from
        // the primary action by the caller's layout, not by hue alone.
        danger:
          "border border-danger bg-danger-dim text-danger-on-bg hover:bg-danger hover:text-on-action",
        dangerInk:
          "on-surface border border-danger bg-danger-dim text-danger-ink hover:bg-danger hover:text-on-action",
      },
      size: {
        // 44px floor everywhere a finger lands.
        md: "min-h-11 px-4 text-body-sm",
        // Same 44px target, visually tighter — padding shrinks, the box does not.
        sm: "min-h-11 px-3 text-body-sm",
        icon: "size-11",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cn(button({ variant, size }), className)} {...props} />
  );
}

export { button as buttonVariants };
