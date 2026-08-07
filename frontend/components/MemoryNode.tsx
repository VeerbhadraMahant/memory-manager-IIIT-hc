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
  memory?: GraphNode;
  label?: string;
  category?: string;
  count?: number;
  expanded?: boolean;
  hasChildren?: boolean;
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
  const { label = "YOU", expanded, onActivate, onToggleExpand } = data as MemoryNodeData;

  return (
    <>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggleExpand?.("root_you")}
        className="flex size-24 cursor-pointer flex-col items-center justify-center rounded-full border-4 border-[#F77A25] bg-[#303841] shadow-[0_0_25px_rgba(247,122,37,0.6)] transition-all duration-300 hover:scale-110 active:scale-95"
      >
        <span className="font-mono text-lg font-bold tracking-wider text-[#F77A25]">
          {label}
        </span>
        <span className="mt-0.5 text-[10px] text-gray-400">
          {expanded ? "Collapse" : "Expand"}
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
    onToggleExpand,
  } = data as MemoryNodeData & { id: string };

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggleExpand?.(id)}
        className={cn(
          "flex h-14 min-w-[140px] cursor-pointer items-center justify-between gap-3 rounded-full border-2 border-[#C2CEF2] bg-[#1a1c1c] px-4 shadow-[0_0_15px_rgba(194,206,242,0.3)] transition-all duration-300 hover:scale-105 hover:border-[#F77A25]",
          expanded && "border-[#F77A25] shadow-[0_0_20px_rgba(247,122,37,0.5)]",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="inline-block size-2.5 rounded-full bg-[#C2CEF2]" />
          <span className="font-mono text-sm font-semibold text-white">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="rounded-full bg-[#303841] px-2 py-0.5 font-mono text-xs text-[#C2CEF2]">
            {count}
          </span>
          {hasChildren && (
            <span className="font-mono text-xs text-[#F77A25]">
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
              ? "#1e2020"
              : "#121414",
          boxShadow: glow,
          opacity: dim ? 0.35 : 1,
        }}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-card border-2 px-3 py-2 text-left shadow-lg",
          enc.border,
          "transition-all duration-300 hover:scale-102 hover:shadow-[0_0_15px_rgba(247,122,37,0.4)]",
          selected && "ring-2 ring-[#F77A25]",
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
            className="meta font-mono text-xs font-bold"
            style={{ color: selected ? enc.ink : enc.onDark }}
          >
            {enc.label}
          </span>
          {(stale || degraded) && (
            <AlertTriangle
              aria-hidden="true"
              className="ml-auto size-3.5 text-amber-500"
            />
          )}
        </div>

        <p
          className={cn(
            "line-clamp-2 flex-1 text-body-sm text-gray-100",
          )}
        >
          {memory.content}
        </p>

        <div className="flex shrink-0 items-center justify-between gap-x-2 overflow-hidden">
          <span
            className={cn(
              "meta font-mono text-[10px]",
              stale ? "text-red-400" : "text-gray-400",
            )}
          >
            {STATUS_CHIP[memory.status]}
            {stale && " · stale"}
          </span>
          {memory.scope === "session" && (
            <span className="meta font-mono text-[9px] text-[#F77A25]">
              session
            </span>
          )}
        </div>

        {/* Hover Tooltip Preview Card */}
        <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 hidden w-64 -translate-x-1/2 rounded-lg border border-[#F77A25]/40 bg-[#303841]/95 p-3 text-xs text-white shadow-2xl backdrop-blur-md group-hover:block z-50">
          <div className="flex items-center justify-between border-b border-gray-700 pb-1.5 mb-1.5">
            <span className="font-mono text-[10px] text-[#F77A25] font-bold">
              {memory.block_name || "General"}
            </span>
            <span className="font-mono text-[9px] text-gray-400">
              Confidence: {Math.round(memory.confidence * 100)}%
            </span>
          </div>
          <p className="line-clamp-3 text-gray-200">{memory.content}</p>
          <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-gray-400 border-t border-gray-700/50 pt-1">
            <span>Status: {STATUS_CHIP[memory.status]}</span>
            <span>Double-click to Inspect</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

export const MemoryNode = memo(MemoryNodeInner);

