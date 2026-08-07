"use client";

// The mono metadata chips (§1, §4.1). Everything the machine decided about a
// memory wears this: block, status, scope, confidence, source tag.
//
// Two shapes, and the distinction is not cosmetic:
//   <Chip>       reports. Static text.
//   <SelectChip> reports *and* changes it. A native <select>, so it is one
//                interaction, keyboard-operable and labelled for free — and so
//                the thing that displays the classification is the thing that
//                corrects it (P2 one-tap correction).

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { SOURCE } from "@/lib/semantics";
import type { SourceType } from "@/lib/api";

type Tone = "neutral" | "stated" | "inferred" | "alert" | "danger";

const TONE_ON_DARK: Record<Tone, string> = {
  neutral: "bg-white/8 text-ink-invert-muted ring-outline",
  stated: "bg-stated-dim text-stated-on-dark ring-stated/40",
  inferred: "bg-inferred-dim text-inferred-on-dark ring-inferred/40",
  alert: "bg-stated-dim text-stated-on-dark ring-stated/60",
  danger: "bg-danger-dim text-danger-on-dark ring-danger/50",
};

const TONE_ON_LIGHT: Record<Tone, string> = {
  neutral: "bg-black/5 text-ink-muted ring-outline-ink",
  stated: "bg-stated-dim text-stated-ink ring-stated/40",
  inferred: "bg-inferred-dim text-inferred-ink ring-inferred/50",
  alert: "bg-stated-dim text-stated-ink ring-stated/60",
  danger: "bg-danger-dim text-danger-ink ring-danger/50",
};

export function Chip({
  children,
  tone = "neutral",
  onLight,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  onLight?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "meta inline-flex items-center gap-1 rounded-pill px-2 py-1 ring-1",
        onLight ? TONE_ON_LIGHT[tone] : TONE_ON_DARK[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * §4.1's glyph channel: a filled dot for stated, a hollow ring for inferred.
 *
 * The third redundant signal after fill and border style, and the one that
 * survives a greyscale print — which is the actual test of whether colour is
 * carrying meaning alone.
 */
export function SourceGlyph({
  source,
  onLight,
  className,
}: {
  source: SourceType;
  onLight?: boolean;
  className?: string;
}) {
  const enc = SOURCE[source];
  const color = onLight ? enc.ink : enc.onDark;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={
        enc.glyph === "dot"
          ? { background: color }
          : { border: `2px solid ${color}` }
      }
    />
  );
}

/** Source tag: glyph + mono word + colour. Three channels, one component. */
export function SourceChip({
  source,
  onLight,
}: {
  source: SourceType;
  onLight?: boolean;
}) {
  const enc = SOURCE[source];
  return (
    <Chip tone={source} onLight={onLight}>
      <SourceGlyph source={source} onLight={onLight} />
      {enc.label}
    </Chip>
  );
}

export function SelectChip({
  label,
  value,
  options,
  onChange,
  disabled,
  tone = "neutral",
  onLight,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (v: string) => void;
  disabled?: boolean;
  tone?: Tone;
  onLight?: boolean;
}) {
  return (
    <span
      className={cn(
        "meta relative inline-flex items-center rounded-pill ring-1",
        onLight ? TONE_ON_LIGHT[tone] : TONE_ON_DARK[tone],
        disabled && "opacity-50",
      )}
    >
      {/* The visible chip is ~24px tall; the select is stretched to a 44px hit
          area over it without moving anything (§4.1 touch target ≥44). */}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="peer absolute inset-0 h-full min-h-11 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        style={{ minHeight: 44, top: "50%", transform: "translateY(-50%)" }}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <span className="pointer-events-none flex items-center gap-1 px-2 py-1 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--stated-on-dark)]">
        {options.find(([v]) => v === value)?.[1] ?? value}
        <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
      </span>
    </span>
  );
}
