"use client";

// The model's own reasoning for a turn.
//
// Deliberately the only thing left in this file. It briefly also held a retrieval
// panel and a private-blocks notice; both were superseded — the retrieval funnel is
// now one step inside <MemoryTimeline>, where it reads as part of a sequence rather
// than a separate disclosure, and the privacy state lives in <PrivacyBlocks> next to
// its own toggle. Keeping the originals around as unreferenced exports would have
// left two ways to render the same facts, which is how two surfaces start disagreeing.
//
// Kept separate from the memory timeline because reasoning is not a memory operation:
// nothing was retrieved, stored or linked by the model thinking. It is also the one
// panel whose presence is conditional on the provider — see below.

import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * What the model was working through, verbatim.
 *
 * The text is the model's own `<think>` block, separated out in services/llm.py
 * rather than discarded. A model that emits none yields `""` and this renders
 * nothing at all — the alternative, summarising or narrating what the model "probably
 * considered", produces something a reader cannot distinguish from a real trace, and
 * one fabricated panel would make every other honest claim in the project arguable.
 *
 * Of the three configured providers only Groq's qwen3 emits a scratchpad, which is
 * why it is the default chat provider; on the others this component correctly
 * disappears.
 */
export function ThinkingPanel({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning.trim()) return null;

  return (
    <div className="ml-0 rounded-card border border-outline sm:ml-10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap flex w-full items-center gap-2 rounded-card px-2 text-left"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-ink-invert-muted transition-transform duration-[var(--motion-micro)]",
            open && "rotate-90",
          )}
        />
        <Brain className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="meta text-ink-invert-muted">how it worked this out</span>
      </button>
      {open && (
        // Monospace and muted so the scratchpad cannot be mistaken for the answer.
        <p className="meta whitespace-pre-wrap border-t border-outline px-3 py-2 leading-relaxed text-ink-invert-muted">
          {reasoning}
        </p>
      )}
    </div>
  );
}
