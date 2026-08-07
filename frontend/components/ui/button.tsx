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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-input " +
    "font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 " +
    // §7 disabled-states: opacity plus a cursor change, and `disabled` is the
    // real attribute so it is announced rather than merely looking inert.
    "disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // §4: one primary CTA per surface. --accent as a fill with white on it
        // (6.83:1), which is the only thing a fill token is for. Deliberately
        // --accent and not --stated: pressing a button is not a memory
        // semantic, and the green means "you said this" everywhere else.
        //
        // The disabled treatment stays a neutral outline rather than a faded
        // fill. That began as a fix for the old palette — 50% orange over Dark
        // Slate composited to a muted brown, so a disabled Send read as a broken
        // colour rather than a control waiting for input — and it is kept
        // because a half-strength indigo on #F2F2F2 has the same problem.
        primary:
          "bg-accent text-white hover:brightness-110 active:brightness-95 " +
          "disabled:bg-transparent disabled:opacity-100 disabled:border disabled:border-outline-strong " +
          "disabled:text-ink-invert-muted",
        // On the app background.
        outline:
          "border border-outline-strong bg-transparent text-ink-invert hover:bg-raised",
        // On a white card. `on-surface` no longer retunes anything (globals.css).
        outlineInk:
          "on-surface border border-outline-ink bg-transparent text-ink hover:bg-[color:var(--surface-sunken)]/5",
        ghost: "bg-transparent text-ink-invert-muted hover:bg-raised hover:text-ink-invert",
        ghostInk: "on-surface bg-transparent text-ink-muted hover:bg-black/5 hover:text-ink",
        // §7: destructive actions carry the danger colour and are separated from
        // the primary action by the caller's layout, not by hue alone.
        danger:
          "border border-danger bg-danger-dim text-danger-on-bg hover:bg-danger hover:text-white",
        dangerInk:
          "on-surface border border-danger bg-danger-dim text-danger-ink hover:bg-danger hover:text-white",
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
