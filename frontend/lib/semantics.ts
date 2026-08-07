// Redundant encoding, in one place.
//
// frontend_design_guideline §4.1 and §7: stated vs. inferred distinguished by
// colour alone fails WCAG 1.4.1. The fix is not "add a border somewhere" — it is
// that every surface reads the *same* description of what stated and inferred
// look like, so the graph node, the list row and the review card cannot drift
// into encoding it three different ways.
//
// Four redundant channels per §4.1: fill, border style, glyph, mono label.

import type {
  AssertionStatus,
  MemoryItem,
  Scope,
  Sensitivity,
  SourceType,
} from "./api";

export interface SourceEncoding {
  /** Mono tag. The channel that survives greyscale, zoom and a screen reader. */
  label: "STATED" | "INFERRED";
  /** Fill/stroke token name. Never a text colour (§1). */
  fill: string;
  /** Text colour on a light card. */
  ink: string;
  /** Text colour on the dark app background. */
  onBg: string;
  /** Tailwind border utility — solid for stated, dashed for inferred. */
  border: string;
  /** Glyph shape: filled dot vs. hollow ring. Rendered by <SourceGlyph>. */
  glyph: "dot" | "ring";
  /** Plain-language sentence for aria-label and the text equivalent. */
  description: string;
}

export const SOURCE: Record<SourceType, SourceEncoding> = {
  stated: {
    label: "STATED",
    fill: "var(--stated)",
    ink: "var(--stated-ink)",
    onBg: "var(--stated-on-bg)",
    border: "border-solid",
    glyph: "dot",
    description: "you said this",
  },
  inferred: {
    label: "INFERRED",
    fill: "var(--inferred)",
    ink: "var(--inferred-ink)",
    onBg: "var(--inferred-on-bg)",
    border: "border-dashed",
    glyph: "ring",
    description: "the model worked this out",
  },
};

/** Order matters: this is the sequence the status filter renders in, and it runs
 *  most-live to least-live rather than alphabetically. */
export const STATUSES: AssertionStatus[] = [
  "in_progress",
  "completed",
  "planned",
  "abandoned",
  "hypothetical",
  "third_party",
];

/** Mono status chip text (§4.1). Uppercase is applied by the .meta class, so the
 *  string stays readable when it is reused in an aria-label. */
export const STATUS_CHIP: Record<AssertionStatus, string> = {
  in_progress: "in progress",
  completed: "completed",
  planned: "planned",
  abandoned: "abandoned",
  hypothetical: "hypothetical",
  third_party: "third party",
};

export const SENSITIVITIES: Sensitivity[] = [
  "low",
  "medium",
  "high",
  "special_category",
];

export const SCOPES: Scope[] = ["persistent", "session"];

// Mirrors migration 002. Fetched at runtime by the workspace and used as the
// fallback when that fetch has not landed — a review card renders
// mid-conversation and cannot wait on a round trip to show its own chips.
export const FALLBACK_BLOCKS = [
  "unclassified",
  "work",
  "health",
  "family",
  "learning",
];

/**
 * Block names are stored lowercase (migration 002) and were being rendered
 * verbatim in some views and title-cased in others, which put `work` and `Work`
 * on screen at the same time and read as two blocks. One convention, applied in
 * the display layer only: the key is what goes to the API, the label is what a
 * human sees. Never derive one from a hardcoded list — the blocks table is the
 * only source of truth for which blocks exist.
 */
export const blockKey = (name: string) => name.trim().toLowerCase();

export const blockLabel = (name: string) =>
  blockKey(name)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || "Unclassified";

/** Matches the backend's `stale_after_days` default. A guess tuned for a demo,
 *  not a finding — PHASES.md says so and so does the tooltip copy. */
export const STALE_AFTER_DAYS = 14;

/**
 * §4.1: "IN PROGRESS past its staleness threshold gets a visible stale
 * treatment — this is the CV failure case made visible and it must be
 * impossible to miss."
 *
 * Computed client-side from `last_confirmed_at` because the item list endpoint
 * does not carry the `is_stale` flag that retrieval does. Same rule, same
 * threshold; if they ever disagree the backend is right.
 */
export function isStale(item: {
  status: AssertionStatus;
  last_confirmed_at: string | null;
  created_at?: string;
}): boolean {
  if (item.status !== "in_progress") return false;
  const anchor = item.last_confirmed_at ?? item.created_at;
  if (!anchor) return false;
  const days = (Date.now() - new Date(anchor).getTime()) / 86_400_000;
  return days > STALE_AFTER_DAYS;
}

/**
 * The single sentence a screen reader hears for a memory, in the order §3.2
 * requires: content, source, block, status, scope.
 *
 * Every view builds its accessible name from this function. That is the
 * mechanism behind "the graph must have a lossless textual equivalent" — the
 * text is not a transcription of the graph, it is the same string the graph
 * node is labelled with.
 */
export function describeMemory(item: {
  content: string;
  source_type: SourceType;
  status: AssertionStatus;
  scope: Scope;
  block_name: string | null;
  last_confirmed_at?: string | null;
  created_at?: string;
}): string {
  const parts = [
    item.content,
    SOURCE[item.source_type].description,
    `block ${item.block_name ?? "unclassified"}`,
    STATUS_CHIP[item.status],
    item.scope === "session" ? "this chat only" : "remembered across chats",
  ];
  if (isStale({ ...item, last_confirmed_at: item.last_confirmed_at ?? null })) {
    parts.push("not confirmed recently");
  }
  return parts.join(", ") + ".";
}

/** Relation wording for the deletion preview's text equivalent (§4.5). */
export const RELATION_LABEL: Record<string, string> = {
  derived_from: "was worked out from",
  summarized_from: "summarises",
  contradicts: "contradicts",
  updates: "updates",
};

/** Item-shaped or node-shaped; both views hand the same objects to the same
 *  helpers, so the narrow overlap is named once. */
export type MemoryLike = Pick<
  MemoryItem,
  | "id"
  | "content"
  | "source_type"
  | "status"
  | "sensitivity"
  | "scope"
  | "block_name"
  | "review_state"
  | "needs_review"
  | "confidence"
  | "last_confirmed_at"
>;
