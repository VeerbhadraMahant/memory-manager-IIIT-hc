"use client";

// §4.4 — attribution and retrieval highlighting.
//
// The brief's glow tiers are kept (they are the best idea in the source docs)
// but they live in the graph, and the guideline adds the part that makes them
// safe to rely on:
//
//   "Text equivalent required. Attribution chips under each AI message, listing
//    the items used. Clicking a chip highlights the node; the chips work with no
//    graph open at all."
//
// So this component is the primary surface and the graph is the echo. Hovering a
// chip highlights nothing, because §3.3 forbids hover-only affordances — the
// highlight is driven by focus and click, both of which a keyboard reaches.
//
// Honest scope, per PHASES.md: "shaped by N memories" means N memories were
// retrieved and injected. No per-item influence is measured. What revoke buys is
// evidence for one item at a time — drop it, answer again, show the difference
// — which is a demonstration, not a measurement, and the copy says so.

import { useState } from "react";
import { Loader2, Ruler, Undo2 } from "lucide-react";

import {
  api,
  SCOPE_LABEL,
  STATUS_LABEL,
  type InfluenceResponse,
  type MemoryInfluence,
  type UsedMemory,
} from "@/lib/api";
import { blockLabel } from "@/lib/semantics";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";

const VERDICT_LABEL: Record<MemoryInfluence["verdict"], string> = {
  changed_answer: "changed the answer",
  no_measurable_effect: "no measurable effect",
  within_noise: "within noise",
  failed: "could not measure",
};

export function AttributionChips({
  chatId,
  messageId,
  used,
  regenerating,
  onRevoke,
  onHighlight,
  highlighted,
}: {
  chatId: string | null;
  messageId: string | null;
  used: UsedMemory[];
  regenerating: boolean;
  onRevoke: (itemId: string) => void;
  /** Drives the graph's glow tiers. Null clears the highlight. */
  onHighlight: (ids: Map<string, number> | null) => void;
  highlighted: boolean;
}) {
  const [measure, setMeasure] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "done"; res: InfluenceResponse }
    | { state: "error"; message: string }
  >({ state: "idle" });

  if (used.length === 0) return null;

  const run = async () => {
    if (!chatId || !messageId) return;
    setMeasure({ state: "running" });
    try {
      setMeasure({ state: "done", res: await api.measureInfluence(chatId, messageId) });
    } catch (e) {
      setMeasure({ state: "error", message: e instanceof Error ? e.message : "measurement failed" });
    }
  };
  const verdicts = new Map(
    measure.state === "done" ? measure.res.results.map((r) => [r.memory_item_id, r]) : [],
  );

  // Distance → relevance for the glow tiers. Cosine distance, so smaller is
  // closer; the mapping is linear and deliberately coarse — the tiers in §4.4
  // are bands, and pretending to more precision than the retrieval gives would
  // be reading tea leaves.
  const relevance = new Map(
    used.map((m) => [m.id, Math.max(0, Math.min(1, 1 - m.distance))]),
  );

  return (
    <div className="mt-2 max-w-[65ch]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="meta text-ink-invert-muted">
          shaped by {used.length}
        </span>
        <button
          onClick={() => onHighlight(highlighted ? null : relevance)}
          aria-pressed={highlighted}
          className={cn(
            "meta min-h-11 rounded-pill px-3 ring-1 transition-colors duration-[var(--motion-micro)]",
            highlighted
              ? "bg-accent-dim text-accent ring-accent/40"
              : "bg-ink-invert/[0.06] text-ink-invert-muted ring-outline hover:text-ink-invert",
          )}
        >
          {highlighted ? "clear highlight" : "show in graph"}
        </button>
      </div>

      {messageId && (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={measure.state === "running" || regenerating}
            onClick={() => void run()}
          >
            {measure.state === "running" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Ruler className="size-4" aria-hidden="true" />
            )}
            Measure influence
          </Button>
          <p className="meta mt-1 text-ink-invert-muted">
            Regenerates this answer {used.length + 2} times on the same model (once
            without each memory, twice with all of them) and uses your model quota.
            It compares answers; it does not prove why the model said what it said.
          </p>
          <p role="status" className="text-body-sm text-ink-invert-muted">
            {measure.state === "running" && "Measuring by regenerating, this can take a while."}
            {measure.state === "done" &&
              `Measured with ${measure.res.calls_made} regenerations on ${measure.res.model ?? "the same model"}.`}
            {measure.state === "error" && `Could not measure: ${measure.message}`}
          </p>
        </div>
      )}

      <ul className="mt-2 space-y-2">
        {used.map((m) => (
          <li
            key={m.id}
            className="rounded-input border border-outline bg-raised p-3"
          >
            <p className="text-body-sm text-ink-invert">{m.content}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Chip>{blockLabel(m.block_name ?? "unclassified")}</Chip>
              <Chip>{STATUS_LABEL[m.status]}</Chip>
              <Chip tone={m.scope === "session" ? "alert" : "neutral"}>
                {SCOPE_LABEL[m.scope]}
              </Chip>
              {m.is_stale && <Chip tone="danger">not confirmed recently</Chip>}
              <Chip tone={verdicts.get(m.id)?.verdict === "changed_answer" ? "stated" : "neutral"}>
                {verdicts.has(m.id)
                  ? VERDICT_LABEL[verdicts.get(m.id)!.verdict]
                  : "used as context"}
              </Chip>

              {/* Revoke is a memory-level act, not a display filter: the item is
                  dropped from the prompt and the answer is redone without it, so
                  the influence is shown rather than claimed (P6). */}
              <Button
                variant="ghost"
                size="sm"
                disabled={regenerating}
                className="ml-auto"
                onClick={() => onRevoke(m.id)}
              >
                <Undo2 className="size-4" aria-hidden="true" />
                Drop this and answer again
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
