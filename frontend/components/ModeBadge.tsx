"use client";

import { Info } from "lucide-react";

import { cn } from "@/lib/utils";

type Tone = "danger" | "accent" | "stated";

// Only the *active* badge is coloured; inactive ones are neutral outlines. Three always-on
// colours would put three chromatic hues in one row, which the style forbids and which
// makes "which mode am I in" harder to read, not easier. The word carries the meaning;
// colour is the redundant second channel.
const ACTIVE: Record<Tone, string> = {
  danger: "border-danger bg-danger-dim text-danger-on-bg",
  accent: "border-accent bg-accent-dim text-accent",
  stated: "border-stated bg-stated-dim text-stated-on-bg",
};

const INACTIVE =
  "border-outline-strong bg-transparent text-ink-invert-muted hover:bg-ink-invert/[0.06] hover:text-ink-invert";

/** A pill toggle with an ⓘ that reveals what the mode does, on hover and on keyboard focus. */
export function ModeBadge({
  label,
  tone,
  active,
  onClick,
  tipTitle,
  tip,
}: {
  label: string;
  tone: Tone;
  active: boolean;
  onClick: () => void;
  tipTitle: string;
  tip: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group relative flex min-h-11 shrink-0 items-center gap-2 rounded-pill border px-3.5 text-body-sm transition-colors",
        active ? ACTIVE[tone] : INACTIVE,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-pill", active ? "animate-pulse bg-current" : "border border-current")}
      />
      <span className={active ? "font-medium" : "font-normal"}>{label}</span>
      <span className="relative ml-0.5 inline-flex items-center justify-center">
        <Info className="size-3.5 shrink-0 opacity-70 group-hover:opacity-100" aria-hidden="true" />
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-card border border-outline-strong bg-elevated px-3.5 py-3 text-left text-body-sm font-normal text-ink opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span className="mb-1 block font-medium">{tipTitle}</span>
          {tip}
        </span>
      </span>
    </button>
  );
}
