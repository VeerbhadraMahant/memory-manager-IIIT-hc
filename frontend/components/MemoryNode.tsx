"use client";

// §4.1 memory node, as a React Flow custom node.
//
// React Flow was chosen (§3) precisely so this could be a real DOM element:
// Cytoscape draws to canvas, which is a black box to a screen reader, and there
// is no accessible-name property on a pixel. Everything below is why that
// mattered — role, tabIndex, aria-label, aria-pressed, arrow-key handling, all
// of which come for free on a <div> and are impossible on a <canvas>.
//
// Redundant encoding per §4.1, four channels, none of them colour alone:
//
//            Stated              Inferred
//   Fill     --stated            --inferred
//   Border   2px solid           2px dashed
//   Glyph    filled dot          hollow ring
//   Label    STATED              INFERRED

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";

import type { GraphNode } from "@/lib/api";
import { SOURCE, STATUS_CHIP, describeMemory, isStale } from "@/lib/semantics";
import { cn } from "@/lib/utils";
import { NODE_H, NODE_W } from "@/lib/graph-layout";

export interface MemoryNodeData extends Record<string, unknown> {
  memory: GraphNode;
  selected: boolean;
  /** In the subgraph the open deletion preview would destroy (§4.5). */
  doomed: boolean;
  /** Survives that delete, but gets flagged. */
  degraded: boolean;
  /** Retrieval highlighting (§4.4): 0 = unrelated and dimmed, 1 = strongest. */
  relevance: number | null;
  unconnected: boolean;
  onActivate: (id: string) => void;
  onArrow: (id: string, key: string) => void;
}

function MemoryNodeInner({ data }: NodeProps) {
  const {
    memory,
    selected,
    doomed,
    degraded,
    relevance,
    unconnected,
    onActivate,
    onArrow,
  } = data as MemoryNodeData;

  const enc = SOURCE[memory.source_type];
  const stale = isStale(memory);

  // §4.4 glow tiers, kept from the brief. Unrelated nodes dim rather than
  // disappear — removing them would change what the graph claims exists.
  const dim = relevance !== null && relevance < 0.2;
  const glow =
    relevance === null || relevance < 0.2
      ? "none"
      : relevance >= 0.95
        ? `0 0 0 3px ${enc.fill}, 0 0 24px 2px ${enc.fill}`
        : relevance >= 0.6
          ? `0 0 0 2px ${enc.fill}, 0 0 14px 1px ${enc.fill}`
          : `0 0 0 2px ${enc.fill}`;

  return (
    <>
      {/* Hidden in CSS; React Flow still needs them to route edges. */}
      <Handle type="target" position={Position.Top} isConnectable={false} />

      <div
        // §3.2: every node is focusable, labelled, and operable from the
        // keyboard. `role="button"` + tabIndex + Enter/Space is the full
        // contract; arrow keys walk to connected nodes on top of it.
        role="button"
        tabIndex={0}
        aria-label={describeMemory(memory)}
        aria-pressed={selected}
        onClick={() => onActivate(memory.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate(memory.id);
          } else if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            onArrow(memory.id, e.key);
          }
        }}
        style={{
          width: NODE_W,
          height: NODE_H,
          borderColor: doomed ? "var(--danger)" : enc.fill,
          background: doomed
            ? "var(--danger-dim)"
            : selected
              ? "var(--surface)"
              : "var(--surface-raised)",
          boxShadow: glow,
          opacity: dim ? 0.35 : 1,
        }}
        className={cn(
          // overflow-hidden, because the box is a fixed size and a long memory
          // must clip rather than push the status row out of its own node.
          "flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-card border-2 px-3 py-2 text-left",
          // The border-style channel. Not decoration — it is what carries
          // stated/inferred when colour does not (§4.1, WCAG 1.4.1).
          enc.border,
          "transition-[opacity,box-shadow,background-color] duration-[var(--motion-state)]",
          selected && "on-surface ring-2 ring-[color:var(--stated)]",
          unconnected && !selected && "opacity-90",
        )}
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={
              enc.glyph === "dot"
                ? { background: selected ? enc.ink : enc.onDark }
                : { border: `2px solid ${selected ? enc.ink : enc.onDark}` }
            }
          />
          <span
            className="meta"
            style={{ color: selected ? enc.ink : enc.onDark }}
          >
            {enc.label}
          </span>
          {(stale || degraded) && (
            <AlertTriangle
              aria-hidden="true"
              className="ml-auto size-3.5"
              style={{ color: selected ? "var(--danger-ink)" : "var(--danger-on-dark)" }}
            />
          )}
        </div>

        <p
          className={cn(
            "line-clamp-2 flex-1 text-body-sm",
            selected ? "text-ink" : "text-ink-invert",
          )}
        >
          {memory.content}
        </p>

        <div className="flex shrink-0 items-center gap-x-2 overflow-hidden">
          <span
            className={cn(
              "meta",
              stale
                ? selected
                  ? "text-danger-ink"
                  : "text-danger-on-dark"
                : selected
                  ? "text-ink-muted"
                  : "text-ink-invert-muted",
            )}
          >
            {STATUS_CHIP[memory.status]}
            {stale && " · stale"}
          </span>
          {memory.scope === "session" && (
            <span
              className="meta"
              style={{ color: selected ? "var(--stated-ink)" : "var(--stated-on-dark)" }}
            >
              this chat only
            </span>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

export const MemoryNode = memo(MemoryNodeInner);
