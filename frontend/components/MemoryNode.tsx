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
import { CAT_H, CAT_W, NODE_H, NODE_W, ROOT_H, ROOT_W } from "@/lib/graph-layout";

export interface MemoryNodeData extends Record<string, unknown> {
  memory?: GraphNode;
  label?: string;
  category?: string;
  categoryLabel?: string;
  count?: number;
  expanded?: boolean;
  hasChildren?: boolean;
  /** Block with nothing in it — drawn recessive so it cannot be mistaken for a
   *  populated one (§12 of the fix list; identical treatment was pure noise). */
  empty?: boolean;
  selected?: boolean;
  doomed?: boolean;
  degraded?: boolean;
  relevance?: number | null;
  unconnected?: boolean;
  onToggleExpand?: (id: string) => void;
  onActivate?: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  onArrow?: (id: string, key: string) => void;
}

export function RootNode({ data }: NodeProps) {
  const { label = "YOU", expanded, onToggleExpand } = data as MemoryNodeData;

  return (
    <>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Everything it knows about you. ${expanded ? "Expanded" : "Collapsed"}.`}
        onClick={() => onToggleExpand?.("root_you")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand?.("root_you");
          }
        }}
        style={{ width: ROOT_W, height: ROOT_H }}
        className="flex cursor-pointer flex-col items-center justify-center rounded-full border-4 border-stated bg-bg transition-transform duration-[var(--motion-state)] hover:scale-105 active:scale-95"
      >
        <span className="meta text-base font-bold text-stated-on-bg">{label}</span>
        <span className="meta mt-0.5 text-ink-invert-muted">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>
      <Handle type="target" position={Position.Top} isConnectable={false} />
    </>
  );
}

export function CategoryNode({ data }: NodeProps) {
  const {
    id,
    label,
    count = 0,
    expanded,
    hasChildren,
    empty,
    onToggleExpand,
  } = data as MemoryNodeData & { id: string };

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        role="button"
        tabIndex={0}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={
          empty
            ? `${label} block, empty.`
            : `${label} block, ${count} ${count === 1 ? "memory" : "memories"}. ${expanded ? "Expanded" : "Collapsed"}.`
        }
        onClick={() => onToggleExpand?.(id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand?.(id);
          }
        }}
        style={{ width: CAT_W, height: CAT_H }}
        className={cn(
          "flex cursor-pointer items-center justify-between gap-3 rounded-pill border-2 border-inferred bg-sunken px-4",
          "transition-colors duration-[var(--motion-state)] hover:border-stated",
          expanded && !empty && "border-stated",
          // Recessive, not identical: an empty block is a place a memory could
          // go, not a thing the model knows.
          empty && "border-dashed border-outline-strong opacity-55",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "inline-block size-2.5 shrink-0 rounded-full",
              empty ? "bg-transparent ring-1 ring-outline-strong" : "bg-inferred",
            )}
          />
          <span className="meta truncate text-ink-invert">{label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "meta tnum rounded-pill px-2 py-0.5",
              empty
                ? "text-ink-invert-muted"
                : "bg-raised text-inferred-on-bg",
            )}
          >
            {count}
          </span>
          {hasChildren && (
            <span aria-hidden="true" className="meta text-stated-on-bg">
              {expanded ? "−" : "+"}
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
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
    onDoubleClick,
    onContextMenu,
    onArrow,
  } = data as MemoryNodeData;

  if (!memory) return null;

  const enc = SOURCE[memory.source_type];
  const stale = isStale(memory);

  const relVal = relevance ?? null;
  const dim = relVal !== null && relVal < 0.2;
  const glow =
    relVal === null || relVal < 0.2
      ? "none"
      : relVal >= 0.95
        ? `0 0 0 3px ${enc.fill}, 0 0 24px 2px ${enc.fill}`
        : relVal >= 0.6
          ? `0 0 0 2px ${enc.fill}, 0 0 14px 1px ${enc.fill}`
          : `0 0 0 2px ${enc.fill}`;

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />

      <div
        role="button"
        tabIndex={0}
        aria-label={describeMemory(memory)}
        aria-pressed={selected}
        onClick={() => onActivate?.(memory.id)}
        onDoubleClick={() => onDoubleClick?.(memory.id)}
        onContextMenu={(e) => onContextMenu?.(e, memory.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate?.(memory.id);
          } else if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            onArrow?.(memory.id, e.key);
          }
        }}
        style={{
          width: NODE_W,
          height: NODE_H,
          borderColor: doomed ? "var(--danger)" : enc.fill,
          background: doomed
            ? "var(--danger-dim)"
            : selected
              ? "var(--surface-raised)"
              : "var(--surface-sunken)",
          boxShadow: glow,
          opacity: dim ? 0.35 : 1,
        }}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-card border-2 px-3 py-2 text-left",
          enc.border,
          "transition-colors duration-[var(--motion-state)]",
          selected && "ring-2 ring-[color:var(--stated)]",
          unconnected && !selected && "opacity-90",
        )}
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={
              enc.glyph === "dot"
                ? { background: selected ? enc.ink : enc.onBg }
                : { border: `2px solid ${selected ? enc.ink : enc.onBg}` }
            }
          />
          <span
            className="meta font-mono text-xs font-bold"
            style={{ color: selected ? enc.ink : enc.onBg }}
          >
            {enc.label}
          </span>
          {(stale || degraded) && (
            <AlertTriangle
              aria-hidden="true"
              className="ml-auto size-3.5 text-[color:var(--danger)]"
            />
          )}
        </div>

        <p className="line-clamp-2 flex-1 text-body-sm text-ink-invert">
          {memory.content}
        </p>

        <div className="flex shrink-0 items-center justify-between gap-x-2 overflow-hidden">
          <span
            className={cn(
              "meta truncate",
              stale ? "text-danger-on-bg" : "text-ink-invert-muted",
            )}
          >
            {STATUS_CHIP[memory.status]}
            {stale && " · stale"}
          </span>
          {memory.scope === "session" && (
            <span className="meta shrink-0 text-alert-ink">session</span>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

export const MemoryNode = memo(MemoryNodeInner);

