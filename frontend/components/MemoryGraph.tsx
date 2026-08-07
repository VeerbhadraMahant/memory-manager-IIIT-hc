"use client";

// §3 — the graph view.
//
// Coequal with the list, not a decoration on it (§2). The task split is the
// honest way to think about what it is *for*: the list answers "what does it
// know about me", the graph answers "what is connected to what". Everything
// actionable is reachable in both, because the detail panel below mounts the
// same <MemoryActionBar> the list rows mount.
//
// The four non-negotiables from §3, and where each one lives:
//   1. Deterministic layout        → lib/graph-layout.ts (dagre, sorted input)
//   2. Focusable, labelled nodes   → components/MemoryNode.tsx
//   3. No hover-only actions       → nothing here has an onMouseEnter handler
//   4. Node cap at ~150            → NODE_CAP, plus the backend's own cap
//   5. prefers-reduced-motion      → globals.css blanket override + fitView flag

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  CheckSquare,
  Edit3,
  FileText,
  Filter,
  GitBranch,
  GitMerge,
  History,
  Info,
  Layers,
  Maximize2,
  Minimize2,
  MessageSquare,
  Network,
  PlusCircle,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";

import type { GraphNode, MemoryItem, ProvenanceGraph } from "@/lib/api";
import { useMemoryStore } from "@/lib/memory-store";
import {
  NODE_CAP,
  NODE_H,
  NODE_W,
  adjacency,
  buildHierarchicalGraph,
  layoutGraph,
  layoutHierarchicalGraph,
} from "@/lib/graph-layout";
import { RELATION_LABEL, STATUS_CHIP, describeMemory } from "@/lib/semantics";
import { MemoryActionBar, MemorySummary } from "@/components/MemoryActionBar";
import {
  CategoryNode,
  MemoryNode,
  RootNode,
  type MemoryNodeData,
} from "@/components/MemoryNode";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

const nodeTypes = {
  root: RootNode,
  category: CategoryNode,
  memory: MemoryNode,
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export function MemoryGraph(props: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  preview: ProvenanceGraph | null;
  relevance: Map<string, number> | null;
  onRequestDelete: (item: MemoryItem) => void;
}) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphInner({
  selectedId,
  onSelect,
  preview,
  relevance,
  onRequestDelete,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  preview: ProvenanceGraph | null;
  relevance: Map<string, number> | null;
  onRequestDelete: (item: MemoryItem) => void;
}) {
  const { graph, items } = useMemoryStore();
  const reduced = usePrefersReducedMotion();
  const { setViewport, fitBounds } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);

  // Graph modes: "hierarchical" (interactive Mindmap) vs "provenance" (DAG layout)
  const [viewMode, setViewMode] = useState<"hierarchical" | "provenance">("hierarchical");
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => new Set(["root_you", "cat_Personal", "cat_Work", "cat_Projects", "cat_General"]),
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const source = useMemo(() => graph?.nodes ?? [], [graph]);
  const rawEdges = useMemo(() => graph?.edges ?? [], [graph]);
  const capped = source.length > NODE_CAP;
  const visible = useMemo(() => source.slice(0, NODE_CAP), [source]);

  // Toggle node expansion
  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Hierarchical graph data
  const hierarchicalData = useMemo(() => {
    const { hNodes, hEdges } = buildHierarchicalGraph(visible, rawEdges, expandedNodes);
    return layoutHierarchicalGraph(hNodes, hEdges);
  }, [visible, rawEdges, expandedNodes]);

  // Provenance DAG layout data
  const provenanceLayout = useMemo(() => layoutGraph(visible, rawEdges), [visible, rawEdges]);

  // Select layout based on viewMode
  const layout = viewMode === "hierarchical" ? hierarchicalData : provenanceLayout;
  const neighbours = useMemo(() => adjacency(rawEdges), [rawEdges]);

  const doomed = useMemo(
    () => new Set(preview?.cascade ? [preview.cascade.root_id, ...preview.cascade.cascade_delete] : []),
    [preview],
  );
  const degraded = useMemo(
    () =>
      new Set(
        preview?.cascade
          ? [...preview.cascade.flag_for_review, ...preview.cascade.relationship_affected]
          : [],
      ),
    [preview],
  );

  const focusNode = useCallback((id: string) => {
    canvas.current
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] [role="button"]`)
      ?.focus();
  }, []);

  const onArrow = useCallback(
    (id: string, key: string) => {
      const linked = neighbours.get(id);
      if (linked?.length) {
        const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
        focusNode(linked[(linked.length + step) % linked.length]);
        return;
      }
      const order = visible.map((p) => p.id);
      const at = order.indexOf(id);
      if (at === -1) return;
      const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      focusNode(order[(at + step + order.length) % order.length]);
    },
    [neighbours, visible, focusNode],
  );

  const handleActivateNode = useCallback(
    (id: string) => {
      if (multiSelectMode) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else {
        onSelect(id === selectedId ? null : id);
      }
    },
    [multiSelectMode, selectedId, onSelect],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, id });
  }, []);

  // Filter & search matching
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    const matches = new Set<string>();
    visible.forEach((n) => {
      if (n.content.toLowerCase().includes(q) || n.block_name?.toLowerCase().includes(q)) {
        matches.add(n.id);
      }
    });
    return matches;
  }, [searchQuery, visible]);

  // Nodes for React Flow
  const nodes: Node<MemoryNodeData>[] = useMemo(
    () =>
      layout.nodes.map((p) => {
        const isMem = "memory" in p && p.memory;
        const memObj = isMem ? p.memory : undefined;
        const id = p.id;
        const isMatch = searchMatches ? searchMatches.has(id) : null;

        return {
          id,
          type: p.type || "memory",
          position: { x: p.x, y: p.y },
          width: p.type === "root" ? 96 : p.type === "category" ? 160 : NODE_W,
          height: p.type === "root" ? 96 : p.type === "category" ? 56 : NODE_H,
          draggable: false,
          focusable: false,
          data: {
            id,
            label: p.label,
            category: p.category,
            count: p.count,
            memory: memObj,
            expanded: p.expanded,
            hasChildren: p.hasChildren,
            selected: id === selectedId || selectedIds.has(id),
            doomed: doomed.has(id),
            degraded: degraded.has(id),
            relevance: isMatch !== null ? (isMatch ? 1.0 : 0.1) : relevance?.get(id) ?? null,
            unconnected: false,
            onToggleExpand: toggleExpand,
            onActivate: handleActivateNode,
            onDoubleClick: (nodeId: string) => setInspectorId(nodeId),
            onContextMenu: handleContextMenu,
            onArrow,
          },
        };
      }),
    [
      layout.nodes,
      selectedId,
      selectedIds,
      doomed,
      degraded,
      relevance,
      searchMatches,
      toggleExpand,
      handleActivateNode,
      handleContextMenu,
      onArrow,
    ],
  );

  // Edges for React Flow
  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e) => {
        const dying = doomed.has(e.source || (e as any).from_item_id) || doomed.has(e.target || (e as any).to_item_id);
        const sourceId = e.source || (e as any).from_item_id;
        const targetId = e.target || (e as any).to_item_id;
        const isHighlighted = searchMatches && (searchMatches.has(sourceId) || searchMatches.has(targetId));

        return {
          id: e.id || `${sourceId}-${targetId}`,
          source: sourceId,
          target: targetId,
          label: e.relation && e.relation !== "contains" && e.relation !== "item" ? RELATION_LABEL[e.relation] || e.relation : undefined,
          labelShowBg: true,
          labelBgStyle: { fill: "#1a1c1c" },
          labelStyle: { fill: "#C2CEF2", fontSize: 10, fontFamily: "monospace" },
          animated: e.provisional,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isHighlighted ? "#F77A25" : dying ? "#ef4444" : "#574237",
          },
          style: {
            stroke: isHighlighted ? "#F77A25" : dying ? "#ef4444" : "#574237",
            strokeWidth: isHighlighted ? 2.5 : dying ? 2 : 1.5,
            strokeDasharray: e.provisional ? "5 5" : undefined,
          },
        };
      }),
    [layout.edges, doomed, searchMatches],
  );

  const [pane, setPane] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setPane((p) => (p.w === width && p.h === height ? p : { w: width, h: height }));
    };
    const t = setTimeout(measure, 0);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const fitted = useRef(false);
  useEffect(() => {
    if (!pane.w || !pane.h || layout.nodes.length === 0) return;
    const inset = 0.85;
    const zoom = Math.max(
      0.25,
      Math.min(
        (pane.w * inset) / Math.max(layout.width, 1),
        (pane.h * inset) / Math.max(layout.height, 1),
        1,
      ),
    );
    const duration = fitted.current && !reduced ? 350 : 0;
    fitted.current = true;
    setViewport(
      {
        x: (pane.w - layout.width * zoom) / 2,
        y: (pane.h - layout.height * zoom) / 2,
        zoom,
      },
      { duration },
    );
  }, [pane, layout, setViewport, reduced]);

  // Auto-center camera on searched match
  useEffect(() => {
    if (searchMatches && searchMatches.size > 0) {
      const firstMatchId = Array.from(searchMatches)[0];
      const matchNode = layout.nodes.find((n) => n.id === firstMatchId);
      if (matchNode) {
        fitBounds(
          {
            x: matchNode.x - 100,
            y: matchNode.y - 100,
            width: 400,
            height: 300,
          },
          { duration: 500 },
        );
      }
    }
  }, [searchMatches, layout.nodes, fitBounds]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const inspectorNode = visible.find((n) => n.id === inspectorId) ?? null;
  const inspectorItem = items.find((i) => i.id === inspectorId) ?? null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      onClick={() => setContextMenu(null)}
    >
      {/* Top Interactive Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#574237] bg-[#303841] p-3 text-white shadow-xl">
        {/* Search Bar */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search memory graph..."
            className="w-full rounded-full border border-gray-600 bg-[#1a1c1c] py-1.5 pl-9 pr-8 text-xs text-white placeholder-gray-400 focus:border-[#F77A25] focus:outline-none focus:ring-1 focus:ring-[#F77A25]"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("hierarchical")}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-mono transition-colors",
              viewMode === "hierarchical"
                ? "bg-[#F77A25] text-black font-bold"
                : "bg-[#1a1c1c] text-gray-300 hover:text-white",
            )}
          >
            <Sparkles className="size-3.5" />
            Mindmap
          </button>
          <button
            onClick={() => setViewMode("provenance")}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-mono transition-colors",
              viewMode === "provenance"
                ? "bg-[#F77A25] text-black font-bold"
                : "bg-[#1a1c1c] text-gray-300 hover:text-white",
            )}
          >
            <Network className="size-3.5" />
            Provenance DAG
          </button>
        </div>

        {/* Multi-Select & Expansion Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setMultiSelectMode((prev) => !prev);
              setSelectedIds(new Set());
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-gray-600 px-2.5 py-1 text-xs font-mono text-gray-300 hover:bg-[#1a1c1c]",
              multiSelectMode && "border-[#F77A25] text-[#F77A25]",
            )}
          >
            {multiSelectMode ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
            Multi-Select {selectedIds.size > 0 && `(${selectedIds.size})`}
          </button>

          <button
            onClick={() =>
              setExpandedNodes(
                new Set([
                  "root_you",
                  "cat_Personal",
                  "cat_Work",
                  "cat_Projects",
                  "cat_Preferences",
                  "cat_Health",
                  "cat_Learning",
                  "cat_General",
                  ...visible.map((n) => n.id),
                ]),
              )
            }
            className="flex items-center gap-1 rounded-md border border-gray-600 bg-[#1a1c1c] px-2.5 py-1 text-xs font-mono text-gray-300 hover:text-white"
          >
            <Maximize2 className="size-3" /> Expand All
          </button>

          <button
            onClick={() => setExpandedNodes(new Set(["root_you"]))}
            className="flex items-center gap-1 rounded-md border border-gray-600 bg-[#1a1c1c] px-2.5 py-1 text-xs font-mono text-gray-300 hover:text-white"
          >
            <Minimize2 className="size-3" /> Collapse All
          </button>
        </div>
      </div>

      {actionNotice && (
        <div className="rounded-md border border-[#F77A25]/40 bg-[#F77A25]/10 px-4 py-2 text-xs font-mono text-[#F77A25]">
          {actionNotice}
        </div>
      )}

      {/* Main Canvas & Detail Sidebar */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Canvas Surface */}
        <div className="relative flex h-[70dvh] min-h-[460px] flex-1 flex-col overflow-hidden rounded-card border border-[#574237] bg-[#303841] shadow-2xl">
          {capped && (
            <p className="border-b border-[#574237] bg-[#F77A25]/10 px-4 py-2 text-xs font-mono text-[#F77A25]">
              Showing {NODE_CAP} of {source.length} memories.
            </p>
          )}

          <div ref={canvas} className="relative min-h-0 flex-1 cursor-grab active:cursor-grabbing">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitViewOptions={{ padding: 0.15 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
              minZoom={0.15}
              maxZoom={1.8}
              onPaneClick={() => {
                onSelect(null);
                setInspectorId(null);
              }}
              aria-label="Interactive Memory Knowledge Graph"
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#574237" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </div>

        {/* Selected Node Sidebar */}
        <aside aria-label="Selected memory details" className="w-full shrink-0 rounded-card border border-[#574237] bg-[#1a1c1c] p-4 text-white shadow-2xl lg:w-96">
          {selected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-gray-700 pb-2">
                <span className="font-mono text-xs font-bold text-[#F77A25]">
                  {selected.block_name || "General"}
                </span>
                <button
                  onClick={() => setInspectorId(selected.id)}
                  className="flex items-center gap-1 rounded bg-[#303841] px-2.5 py-1 text-xs font-mono text-[#C2CEF2] hover:bg-gray-700"
                >
                  <Layers className="size-3" /> Inspect Node
                </button>
              </div>

              <p className="text-sm text-gray-100">{selected.content}</p>
              <MemorySummary item={selected} />

              <div className="border-t border-gray-700 pt-3">
                <MemoryActionBar item={selected} onRequestDelete={onRequestDelete} />
              </div>
            </div>
          ) : (
            <div className="space-y-3 p-2">
              <h3 className="font-mono text-base font-semibold text-white">Interactive Knowledge Graph</h3>
              <p className="text-xs text-gray-400">
                • Click <strong>YOU</strong> to expand memory categories.
              </p>
              <p className="text-xs text-gray-400">
                • Click a category or memory to toggle expansion.
              </p>
              <p className="text-xs text-gray-400">
                • <strong>Double-click</strong> any node to open the Inspector Panel.
              </p>
              <p className="text-xs text-gray-400">
                • <strong>Right-click</strong> a node for memory actions (Edit, Add Child, Merge, Split).
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* Floating Inspector Panel */}
      {inspectorNode && (
        <div className="fixed right-6 top-24 z-50 w-96 rounded-xl border border-[#F77A25]/50 bg-[#303841]/95 p-5 text-white shadow-[0_10px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-gray-700 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="size-3 rounded-full bg-[#F77A25]" />
              <h3 className="font-mono text-sm font-bold text-white">
                Inspector: {inspectorNode.block_name || "General"}
              </h3>
            </div>
            <button
              onClick={() => setInspectorId(null)}
              className="text-gray-400 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <span className="font-mono text-gray-400">Memory Content</span>
              <p className="mt-1 rounded bg-[#1a1c1c] p-2.5 text-gray-200">{inspectorNode.content}</p>
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono">
              <div className="rounded bg-[#1a1c1c] p-2">
                <span className="text-gray-400">Source Type</span>
                <p className="font-semibold text-[#F77A25]">{inspectorNode.source_type}</p>
              </div>
              <div className="rounded bg-[#1a1c1c] p-2">
                <span className="text-gray-400">Status</span>
                <p className="font-semibold text-white">{STATUS_CHIP[inspectorNode.status]}</p>
              </div>
              <div className="rounded bg-[#1a1c1c] p-2">
                <span className="text-gray-400">Sensitivity</span>
                <p className="font-semibold text-[#C2CEF2]">{inspectorNode.sensitivity}</p>
              </div>
              <div className="rounded bg-[#1a1c1c] p-2">
                <span className="text-gray-400">Confidence</span>
                <p className="font-semibold text-green-400">{Math.round(inspectorNode.confidence * 100)}%</p>
              </div>
            </div>

            {/* Quick Actions inside Inspector */}
            <div className="space-y-2 border-t border-gray-700 pt-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    setActionNotice(`Edit content triggered for node ${inspectorNode.id}`);
                    setTimeout(() => setActionNotice(null), 3000);
                  }}
                  className="flex items-center justify-center gap-1.5 rounded border border-gray-600 bg-[#1a1c1c] py-2 font-mono text-xs hover:border-[#F77A25]"
                >
                  <Edit3 className="size-3.5" /> Edit Content
                </button>
                <button
                  onClick={() => {
                    setActionNotice(`Add Child triggered for node ${inspectorNode.id}`);
                    setTimeout(() => setActionNotice(null), 3000);
                  }}
                  className="flex items-center justify-center gap-1.5 rounded border border-gray-600 bg-[#1a1c1c] py-2 font-mono text-xs hover:border-[#F77A25]"
                >
                  <PlusCircle className="size-3.5" /> Add Child
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    setActionNotice(`Merge branch initiated for node ${inspectorNode.id}`);
                    setTimeout(() => setActionNotice(null), 3000);
                  }}
                  className="flex items-center justify-center gap-1.5 rounded border border-gray-600 bg-[#1a1c1c] py-2 font-mono text-xs hover:border-[#F77A25]"
                >
                  <GitMerge className="size-3.5" /> Merge
                </button>
                <button
                  onClick={() => {
                    setActionNotice(`Split memory initiated for node ${inspectorNode.id}`);
                    setTimeout(() => setActionNotice(null), 3000);
                  }}
                  className="flex items-center justify-center gap-1.5 rounded border border-gray-600 bg-[#1a1c1c] py-2 font-mono text-xs hover:border-[#F77A25]"
                >
                  <GitBranch className="size-3.5" /> Split
                </button>
              </div>

              {inspectorItem && (
                <button
                  onClick={() => {
                    onRequestDelete(inspectorItem);
                    setInspectorId(null);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded border border-red-500/50 bg-red-500/10 py-2 font-mono text-xs text-red-400 hover:bg-red-500/20"
                >
                  <Trash2 className="size-3.5" /> Prune Branch / Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating Right-Click Context Menu */}
      {contextMenu && (
        <div
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 w-48 rounded-lg border border-[#F77A25]/40 bg-[#303841] p-1.5 text-xs text-white shadow-2xl backdrop-blur-xl"
        >
          <button
            onClick={() => {
              setInspectorId(contextMenu.id);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono hover:bg-[#F77A25] hover:text-black"
          >
            <Layers className="size-3.5" /> Inspect Node
          </button>
          <button
            onClick={() => {
              setActionNotice(`Edit requested for node ${contextMenu.id}`);
              setContextMenu(null);
              setTimeout(() => setActionNotice(null), 3000);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono hover:bg-[#F77A25] hover:text-black"
          >
            <Edit3 className="size-3.5" /> Edit Memory
          </button>
          <button
            onClick={() => {
              setActionNotice(`Add Child requested for node ${contextMenu.id}`);
              setContextMenu(null);
              setTimeout(() => setActionNotice(null), 3000);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono hover:bg-[#F77A25] hover:text-black"
          >
            <PlusCircle className="size-3.5" /> Add Child Node
          </button>
          <button
            onClick={() => {
              setActionNotice(`Summary generated for node ${contextMenu.id}`);
              setContextMenu(null);
              setTimeout(() => setActionNotice(null), 3000);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono hover:bg-[#F77A25] hover:text-black"
          >
            <FileText className="size-3.5" /> Generate Summary
          </button>
          <button
            onClick={() => {
              setActionNotice(`History trace opened for node ${contextMenu.id}`);
              setContextMenu(null);
              setTimeout(() => setActionNotice(null), 3000);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono hover:bg-[#F77A25] hover:text-black"
          >
            <History className="size-3.5" /> View History
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Network className="size-8 text-gray-500" aria-hidden="true" />
      <p className="text-base text-gray-200">No memories to draw yet.</p>
      <p className="max-w-sm text-xs text-gray-400">
        Say something in the conversation and keep what comes back. Both views fill up together.
      </p>
      <Chip>Interactive Mindmap</Chip>
    </div>
  );
}


/** The graph's edges for one node, as sentences. §3/§6: any graph capability
 *  must have a lossless textual equivalent, and this is that equivalent —
 *  navigable, not just readable. */
function NodeConnections({
  node,
  graph,
  onSelect,
}: {
  node: GraphNode;
  graph: ProvenanceGraph | null;
  onSelect: (id: string) => void;
}) {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const links = (graph?.edges ?? [])
    .filter((e) => e.from_item_id === node.id || e.to_item_id === node.id)
    .map((e) => {
      const outgoing = e.from_item_id === node.id;
      const other = byId.get(outgoing ? e.to_item_id : e.from_item_id);
      return other ? { other, relation: e.relation, outgoing } : null;
    })
    .filter(Boolean) as { other: GraphNode; relation: string; outgoing: boolean }[];

  if (links.length === 0) {
    return (
      <p className="text-body-sm text-ink-muted">
        Not connected to any other memory.
      </p>
    );
  }

  return (
    <div>
      <h4 className="meta text-ink-muted">Connected to {links.length}</h4>
      <ul className="mt-1.5 space-y-1">
        {links.map(({ other, relation, outgoing }) => (
          <li key={`${other.id}-${relation}-${outgoing}`}>
            <button
              onClick={() => onSelect(other.id)}
              className="on-surface w-full rounded-input px-2 py-2 text-left text-body-sm text-ink hover:bg-black/5"
              aria-label={`${outgoing ? "This" : other.content} ${RELATION_LABEL[relation] ?? relation} ${outgoing ? other.content : "this"}. ${describeMemory(other)}`}
            >
              <span className="meta mr-2 text-ink-muted">
                {outgoing ? "→" : "←"} {RELATION_LABEL[relation] ?? relation}
              </span>
              {other.content}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
