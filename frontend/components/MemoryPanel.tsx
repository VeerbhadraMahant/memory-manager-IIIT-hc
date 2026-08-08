"use client";

// Zone 3 of the shell — the memory side of the negotiation.
//
// ScopePanel, the detection card and <MemoryWorkspace> are moved here from
// page.tsx's right-hand grid column, unchanged. What is new is that the column
// collapses.
//
// Why it collapses: as a permanent half of the viewport it competed with the
// conversation at every moment, including the moments when the conversation was
// the thing to read — and on a projector the transcript is the thing an audience
// can actually follow. Collapsing is not hiding: both toggles carry the memory
// count, so the collapsed state still says there are memories here.
//
// Two things the collapse must not do, and how each is prevented:
//
//   * Lose the graph's selection or the list/graph choice. Those live in
//     <MemoryWorkspace>, so it stays mounted and the panel is hidden with
//     width, transform and visibility rather than by not rendering. Width keeps
//     the inner column at its real 420px, which React Flow needs to measure;
//     `display: none` would report zero and break the canvas on reopen.
//   * Make a memory action unreachable (principle 6). Nothing lives only in
//     here — the panel reopens from the top bar, from the edge rail, and from an
//     attribution chip in the transcript, which opens it on the user's behalf.

import { useRef } from "react";
import {
  Brain,
  PanelRightClose,
  PanelRightOpen,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import type { ScopeReport } from "@/lib/api";
import { useMemoryStore } from "@/lib/memory-store";
import { useAnimateAfterFirstPaint, useFocusTrap } from "@/lib/shell";
import type { PiiFinding, PiiTier } from "@/lib/pii";
import { cn } from "@/lib/utils";
import { MemoryWorkspace } from "@/components/MemoryWorkspace";
import { ScopePanel } from "@/components/ScopePanel";
import { Chip } from "@/components/ui/chip";

export function MemoryPanel({
  open,
  /** True below 1280px, where the panel covers the conversation rather than
   *  sitting beside it — and therefore needs a focus trap and Escape. */
  overlay,
  onToggle,
  scope,
  onScopeChanged,
  findings,
  tier,
  silenced,
  relevance,
  chatId,
  sourceMessageId,
}: {
  open: boolean;
  overlay: boolean;
  onToggle: () => void;
  scope: ScopeReport | null;
  onScopeChanged: () => void;
  findings: PiiFinding[];
  tier: PiiTier | null;
  silenced: number;
  relevance: Map<string, number> | null;
  /** §12: passed straight through to the workspace's Add-memory button. */
  chatId: string | null;
  sourceMessageId: string | null;
}) {
  const panel = useRef<HTMLElement>(null);
  const animate = useAnimateAfterFirstPaint();
  useFocusTrap(panel, overlay && open, onToggle);

  return (
    <>
      {overlay && open && (
        <div
          aria-hidden="true"
          onClick={onToggle}
          className="fixed inset-0 z-30 bg-[color:var(--ink)]/40 xl:hidden"
        />
      )}

      {/* The edge toggle. A rail rather than a button on the panel itself,
          because a collapsed panel has no edge to put a button on. */}
      <div className="hidden w-11 shrink-0 flex-col items-center gap-1 border-l border-outline py-2 lg:flex">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="memory-panel"
          aria-label={open ? "Collapse the memory panel" : "Open the memory panel"}
          title={open ? "Collapse memory" : "Open memory"}
          className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:bg-raised hover:text-ink-invert"
        >
          {open ? (
            <PanelRightClose className="size-5" aria-hidden="true" />
          ) : (
            <PanelRightOpen className="size-5" aria-hidden="true" />
          )}
        </button>
      </div>

      <aside
        ref={panel}
        id="memory-panel"
        aria-label="Memory"
        // Focus target for useFocusTrap when the panel is an overlay; never a
        // tab stop when it is a column.
        tabIndex={-1}
        className={cn(
          // Overlay below 1280px: a sheet over the conversation…
          //
          // The width is scoped to `max-xl` rather than left unprefixed because
          // Tailwind v4 sorts arbitrary values *after* named ones of the same
          // utility, so a bare w-[min(…)] outranks xl:w-0 and the panel never
          // collapses. Non-overlapping variants cannot lose that race.
          "fixed inset-y-0 right-0 z-40 max-xl:w-[min(420px,calc(100vw-3rem))] overflow-hidden border-l border-outline bg-bg shadow-2xl",
          open ? "visible translate-x-0" : "invisible translate-x-full",
          // …and a column of the shell from 1280px up, where it collapses to
          // nothing rather than sliding away. `invisible` when closed is what
          // keeps a zero-width panel out of the tab order — `overflow: hidden`
          // clips it visually and would otherwise leave fifty focusable
          // controls behind a 0px wall.
          "xl:static xl:z-auto xl:translate-x-0 xl:border-l-0 xl:shadow-none",
          open ? "xl:w-[420px]" : "xl:w-0",
          animate && "transition-[width,transform] duration-[var(--motion-state)]",
        )}
      >
        {/* Fixed width, so collapsing the shell above does not reflow the
            contents to 0 and back — the graph would have to re-measure and
            re-fit every time the panel opened. */}
        <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4 xl:w-[420px]">
          <div className="flex shrink-0 items-center justify-end xl:hidden">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls="memory-panel"
              aria-label="Close the memory panel"
              title="Close memory"
              className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:bg-raised hover:text-ink-invert"
            >
              <PanelRightClose className="size-5" aria-hidden="true" />
            </button>
          </div>

          <ScopePanel report={scope} onChanged={onScopeChanged} />

          <div className="shrink-0 rounded-card border border-outline p-4">
            <h2 className="meta mb-2 flex items-center gap-1.5 text-ink-invert-muted">
              {findings.length > 0 ? (
                <ShieldAlert className="size-4" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4" aria-hidden="true" />
              )}
              Detection
            </h2>
            <p className="text-body-sm text-ink-invert-muted">
              Pre-send checks run on this device. Open the network tab — nothing
              leaves before you press Send.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip tone={tier === "irreversible" ? "danger" : tier ? "alert" : "neutral"}>
                {tier ? `${findings.length} found` : "clear"}
              </Chip>
              {silenced > 0 && <Chip>{silenced} silenced this session</Chip>}
            </div>
          </div>

          <MemoryWorkspace
            relevance={relevance}
            chatId={chatId}
            sourceMessageId={sourceMessageId}
          />
        </div>
      </aside>
    </>
  );
}

/**
 * The second toggle, in the conversation's top bar.
 *
 * Labelled with the count rather than with an icon alone: what the collapsed
 * state must not do is imply there is no memory, and "Memory 14" says the
 * opposite of that from across a room.
 */
export function MemoryPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { items } = useMemoryStore();

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="memory-panel"
      // The count is what this button exists to carry to the collapsed state
      // (see the header comment), so it cannot be silently dropped from the
      // accessible name. It would be: the number lives in its own <span>, and
      // Chrome's real accessibility tree gives a button that shape a name of
      // just "Memory" — checked directly, not assumed — losing the count.
      aria-label={`Memory, ${items.length} ${items.length === 1 ? "item" : "items"}`}
      className="tap inline-flex items-center gap-2 rounded-input border border-outline-strong px-3 text-body-sm text-ink-invert-muted hover:text-ink-invert"
    >
      <Brain className="size-4 shrink-0" aria-hidden="true" />
      Memory
      <span className="meta tnum">{items.length}</span>
    </button>
  );
}
