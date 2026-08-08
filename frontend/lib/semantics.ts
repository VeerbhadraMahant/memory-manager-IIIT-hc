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
  ReviewState,
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

// Mirrors migration 005 (which renamed `learning` -> `education` and `family` ->
// `relationships`, and added four). Fetched at runtime by the workspace and used as
// the fallback when that fetch has not landed — a review card renders
// mid-conversation and cannot wait on a round trip to show its own chips.
//
// Ordered most-restrictive-first to match `order by restrictive_rank` on the API,
// so the pre-fetch list and the real one do not visibly reorder themselves.
export const FALLBACK_BLOCKS = [
  "unclassified",
  "health",
  "identity",
  "finance",
  "relationships",
  "location",
  "education",
  "work",
  "preferences",
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
  needs_review?: boolean;
  review_state?: ReviewState;
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
  // §18 wants "flagged for review" visible consistently wherever a surface
  // renders the item. The list row has a chip and the action bar has a summary
  // line, but the graph node has room for neither — putting it here covers the
  // graph through the accessible name every node already builds from this
  // function, which is the same mechanism that makes the graph's textual
  // equivalent lossless rather than a second description that can drift.
  if (item.needs_review && item.review_state !== "pending") {
    parts.push("flagged for review");
  }
  return parts.join(", ") + ".";
}

/**
 * The status chip's tone, in one place so the list row and the action bar cannot
 * disagree about it.
 *
 * Stale wins over everything: an `in_progress` item nobody has re-asserted is
 * the CV failure case, and §18 puts it on `danger`. `third_party` then takes
 * `inferred` — "about someone else" is a different *kind* of claim, not a
 * problem with the claim, so it reads as a classification rather than a warning,
 * and it reuses an existing tone rather than introducing a sixth colour.
 */
export function statusTone(item: {
  status: AssertionStatus;
  last_confirmed_at: string | null;
  created_at?: string;
}): "danger" | "inferred" | "neutral" {
  if (isStale(item)) return "danger";
  if (item.status === "third_party") return "inferred";
  return "neutral";
}

/**
 * "3 days ago" / "never confirmed", for the expanded row's confirmation line.
 *
 * `Intl.RelativeTimeFormat` rather than a date library: it is in every browser
 * this app targets, it localises for free, and a dependency for one string is
 * not a trade worth making. The unit is picked by magnitude so a 40-day-old
 * item reads "1 month ago" instead of "40 days ago" — the staleness *threshold*
 * is 14 days and lives in isStale(), so this line only has to be readable, not
 * precise enough to compute staleness from.
 */
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function lastConfirmedLabel(at: string | null): string {
  if (!at) return "never confirmed";

  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return "never confirmed";

  const seconds = (then - Date.now()) / 1000;
  const magnitude = Math.abs(seconds);

  // Ordered largest-first so the first threshold that fits wins.
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];

  for (const [unit, size] of units) {
    if (magnitude >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return RELATIVE.format(Math.round(seconds), "second");
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
