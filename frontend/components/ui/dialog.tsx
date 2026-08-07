"use client";

// shadcn/ui Dialog over Radix. Used for the two places §4.3 and §4.5 call for a
// focus trap: the irreversible-PII interruption and the deletion confirmation.
//
// Radix gives the parts that are easy to get wrong by hand — focus trap, focus
// restore on close, Escape, `aria-modal`, inert background. §4.6 says override
// the theme via the tokens rather than editing internals, so that is all this
// file does.

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  accent,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** §4.3: a 4px --danger top border marks the irreversible tier. */
  accent?: "danger";
  showClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      {/* Scrim at 60%: strong enough to isolate the foreground, which is the
          point of a modal — §4.6 blur-purpose, not decoration. */}
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[color:var(--surface-sunken)]/70 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
          "on-surface anim-enter overflow-hidden rounded-card bg-surface text-ink shadow-2xl",
          "max-h-[calc(100dvh-2rem)] overflow-y-auto",
          accent === "danger" && "border-t-4 border-t-danger",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            className="tap absolute right-2 top-2 inline-flex items-center justify-center rounded-input text-ink-muted hover:bg-black/5 hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-6 pb-3 pt-6", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-headline-md font-semibold text-ink", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-2 text-body-sm text-ink-muted", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // Column-reverse on mobile puts the primary action nearest the thumb
        // without changing DOM order, so the tab order still reads primary-first.
        "flex flex-col-reverse gap-2 px-6 pb-6 pt-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
