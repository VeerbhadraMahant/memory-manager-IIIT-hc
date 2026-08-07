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
//
// Two rules this file previously broke, both now enforced here rather than
// remembered: §7 forbids raw hex in components (the panels below spend tokens,
// and the panel that sits on a dark surface passes `onLight={false}` so its
// controls are not dark ink on a dark card), and CLAUDE.md's honesty constraint
// forbids controls that only look like they do something — the inspector's
// merge/split/summary buttons announced a notice and changed nothing, so they
// are gone rather than demoed.

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
  Layers,
  Maximize2,
  Minimize2,
  Network,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import type { GraphNode, MemoryItem, ProvenanceGraph } from "@/lib/api";
import { useMemoryStore } from "@/lib/memory-store";
import {
  NODE_CAP,
  adjacency,
  buildHierarchicalGraph,
  catId,
  categoryKeys,
  layoutGraph,
  layoutHierarchicalGraph,
  nodeBox,
} from "@/lib/graph-layout";
import {
  RELATION_LABEL,
  STATUS_CHIP,
  blockLabel,
  describeMemory,
} from "@/lib/semantics";
import { MemoryActionBar, MemorySummary } from "@/components/MemoryActionBar";
import {
  CategoryNode,
  MemoryNode,
  RootNode,
  type MemoryNodeData,
} from "@/components/MemoryNode";
import { Button } from "@/components/ui/button";
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
  const { graph, items, blocks } = useMemoryStore();
  const reduced = usePrefersReducedMotion();
  const { fitView, fitBounds } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);

  // Graph modes: "hierarchical" (blocks and their contents) vs "provenance" (DAG).
  const [viewMode, setViewMode] = useState<"hierarchical" | "provenance">("hierarchical");
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => new Set(["root_you"]),
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const source = useMemo(() => graph?.nodes ?? [], [graph]);
  const rawEdges = useMemo(() => graph?.edges ?? [], [graph]);
  const capped = source.length > NODE_CAP;
  const visible = useMemo(() => source.slice(0, NODE_CAP), [source]);

  // Block nodes come from the blocks the backend actually has, never from a
  // hardcoded list — that list is what put `Projects 0` beside `work 18`.
  const categoryIds = useMemo(
    () => categoryKeys(blocks, visible).map(catId),
    [blocks, visible],
  );

  // Blocks start open once, so the first paint shows what is remembered rather
  // than a single dot. Seeded once, not on every blocks change, or collapsing a
  // block would reopen itself.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || categoryIds.length === 0) return;
    seeded.current = true;
    setExpandedNodes((prev) => new Set([...prev, ...categoryIds]));
  }, [categoryIds]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const hierarchicalData = useMemo(() => {
    const { hNodes, hEdges } = buildHierarchicalGraph(
      visible,
      rawEdges,
      expandedNodes,
      blocks,
    );
    return layoutHierarchicalGraph(hNodes, hEdges);
  }, [visible, rawEdges, expandedNodes, blocks]);

  const provenanceLayout = useMemo(() => layoutGraph(visible, rawEdges), [visible, rawEdges]);

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

  const nodes: Node<MemoryNodeData>[] = useMemo(
    () =>
      layout.nodes.map((p) => {
        const id = p.id;
        const isMatch = searchMatches ? searchMatches.has(id) : null;
        const box = nodeBox(p.type ?? "memory");

        return {
          id,
          type: p.type || "memory",
          position: { x: p.x, y: p.y },
          ...box,
          draggable: false,
          focusable: false,
          data: {
            id,
            label: p.label,
            category: p.category,
            categoryLabel: p.categoryLabel,
            count: p.count,
            memory: p.memory,
            expanded: p.expanded,
            hasChildren: p.hasChildren,
            empty: p.empty,
            selected: id === selectedId || selectedIds.has(id),
            doomed: doomed.has(id),
            degraded: degraded.has(id),
            relevance: isMatch !== null ? (isMatch ? 1.0 : 0.1) : relevance?.get(id) ?? null,
            unconnected: p.unconnected,
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

  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e) => {
        const dying = doomed.has(e.source) || doomed.has(e.target);
        const isHighlighted =
          !!searchMatches && (searchMatches.has(e.source) || searchMatches.has(e.target));
        const stroke = isHighlighted
          ? "var(--stated)"
          : dying
            ? "var(--danger)"
            : "var(--outline-strong)";

        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label:
            e.relation && e.relation !== "contains" && e.relation !== "item"
              ? RELATION_LABEL[e.relation] ?? e.relation
              : undefined,
          labelShowBg: true,
          labelBgStyle: { fill: "var(--surface-sunken)" },
          labelStyle: {
            fill: "var(--inferred-on-bg)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          },
          animated: e.provisional && !reduced,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
          style: {
            stroke,
            strokeWidth: isHighlighted ? 2.5 : dying ? 2 : 1.5,
            strokeDasharray: e.provisional ? "5 5" : undefined,
          },
        };
      }),
    [layout.edges, doomed, searchMatches, reduced],
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

  // React Flow's own fit, not hand-computed viewport maths. The hand-rolled
  // version centred against the *layout* bounds rather than the measured node
  // bounds, so the graph sat off-centre whenever the pane resized under it —
  // which in the split layout it does on every breakpoint.
  const fitted = useRef(false);
  useEffect(() => {
    if (!pane.w || !pane.h || layout.nodes.length === 0) return;
    const duration = fitted.current && !reduced ? 350 : 0;
    fitted.current = true;
    // A frame's grace so React Flow has measured the nodes this layout added.
    const t = setTimeout(
      () => void fitView({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration }),
      0,
    );
    return () => clearTimeout(t);
  }, [pane, layout, fitView, reduced]);

  useEffect(() => {
    if (searchMatches && searchMatches.size > 0) {
      const firstMatchId = Array.from(searchMatches)[0];
      const matchNode = layout.nodes.find((n) => n.id === firstMatchId);
      if (matchNode) {
        fitBounds(
          { x: matchNode.x - 100, y: matchNode.y - 100, width: 400, height: 300 },
          { duration: reduced ? 0 : 500 },
        );
      }
    }
  }, [searchMatches, layout.nodes, fitBounds, reduced]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const inspectorNode = visible.find((n) => n.id === inspectorId) ?? null;
  const inspectorItem = items.find((i) => i.id === inspectorId) ?? null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      onClick={() => setContextMenu(null)}
    >
      {/* ------------------------------------------------------------ toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-outline bg-raised p-3">
        <label className="relative min-w-[200px] max-w-md flex-1">
          <span className="sr-only">Search the memory graph</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-invert-muted"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search memory graph…"
            className="min-h-11 w-full rounded-pill border border-outline-strong bg-sunken pl-9 pr-9 text-body-sm text-ink-invert placeholder:text-ink-invert-muted"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="tap absolute right-0 top-1/2 -translate-y-1/2 text-ink-invert-muted hover:text-ink-invert"
            >
              <span className="sr-only">Clear search</span>
              <X className="mx-auto size-4" aria-hidden="true" />
            </button>
          )}
        </label>

        {/* Wrapping, because the graph now lives in a 420px panel rather than in
            half the viewport: unwrapped, these rows scrolled the panel sideways. */}
        <div role="group" aria-label="Graph layout" className="flex flex-wrap items-center gap-2">
          <ModeButton
            active={viewMode === "hierarchical"}
            onClick={() => setViewMode("hierarchical")}
            icon={<Sparkles className="size-4" aria-hidden="true" />}
          >
            Blocks
          </ModeButton>
          <ModeButton
            active={viewMode === "provenance"}
            onClick={() => setViewMode("provenance")}
            icon={<Network className="size-4" aria-hidden="true" />}
          >
            Provenance
          </ModeButton>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* §14: a real Lucide icon with an announced pressed state, not a
              checkbox glyph that could mean either thing. */}
          <Button
            variant={multiSelectMode ? "primary" : "outline"}
            size="sm"
            aria-pressed={multiSelectMode}
            onClick={() => {
              setMultiSelectMode((prev) => !prev);
              setSelectedIds(new Set());
            }}
          >
            <CheckSquare className="size-4" aria-hidden="true" />
            Select several
            {selectedIds.size > 0 && <span className="tnum">({selectedIds.size})</span>}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setExpandedNodes(
                new Set(["root_you", ...categoryIds, ...visible.map((n) => n.id)]),
              )
            }
          >
            <Maximize2 className="size-4" aria-hidden="true" /> Expand all
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpandedNodes(new Set(["root_you"]))}
          >
            <Minimize2 className="size-4" aria-hidden="true" /> Collapse all
          </Button>
        </div>
      </div>

      {/* --------------------------------------------- canvas + detail panel */}
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* Stacked, not side by side. In the split layout this whole workspace is
           half the viewport, and a 380px detail rail beside the canvas left the
           graph too narrow to read at any usable zoom. */}
        <div className="relative flex h-[68dvh] min-h-[440px] flex-col overflow-hidden rounded-card border border-outline bg-bg">
          {capped && (
            <p className="meta border-b border-outline bg-alert-dim px-4 py-2 text-alert-ink">
              Showing <span className="tnum">{NODE_CAP}</span> of{" "}
              <span className="tnum">{source.length}</span> memories.
            </p>
          )}

          <div ref={canvas} className="relative min-h-0 flex-1 cursor-grab active:cursor-grabbing">
            {visible.length === 0 ? (
              <EmptyCanvas />
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
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
                aria-label="Memory graph"
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={24}
                  size={1.2}
                  color="var(--outline-strong)"
                />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
        </div>

        {/* The dark panel. `onLight={false}` is load-bearing: the shared action
            bar defaults to its off-white-card styling, which on this surface
            rendered `Still true`, `Edit` and `Only this chat` as dark ink on a
            dark card — they read as disabled while Delete stayed visible, which
            is the emphasis exactly backwards. */}
        <aside
          aria-label="Selected memory details"
          className="w-full rounded-card border border-outline bg-raised p-4"
        >
          {selected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 border-b border-outline pb-2">
                <span className="meta text-stated-on-bg">
                  {blockLabel(selected.block_name ?? "unclassified")}
                </span>
                <Button variant="outline" size="sm" onClick={() => setInspectorId(selected.id)}>
                  <Layers className="size-4" aria-hidden="true" /> Inspect
                </Button>
              </div>

              <p className="measure text-body-md text-ink-invert">{selected.content}</p>
              <MemorySummary item={selected} onLight={false} />

              <div className="border-t border-outline pt-3">
                <MemoryActionBar
                  item={selected}
                  onLight={false}
                  onRequestDelete={onRequestDelete}
                />
              </div>

              {/* §3/§6: the graph's edges as sentences, navigable rather than
                  merely readable. */}
              <div className="border-t border-outline pt-3">
                <NodeConnections
                  node={selected}
                  graph={graph}
                  onSelect={(id) => onSelect(id)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <h3 className="text-headline-md text-ink-invert">Nothing selected</h3>
              <p className="text-body-sm text-ink-invert-muted">
                Click <strong>YOU</strong> to fold the blocks away, a block to open
                it, or a memory to act on it here. Everything in this panel is also
                in the list view.
              </p>
              <p className="text-body-sm text-ink-invert-muted">
                Keyboard: Tab reaches every node, Enter selects, arrow keys walk
                between connected memories.
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* ------------------------------------------------------- inspector */}
      {inspectorNode && (
        <div
          role="dialog"
          aria-label={`Inspector: ${inspectorNode.content}`}
          className="fixed right-6 top-24 z-50 max-h-[70dvh] w-96 overflow-y-auto rounded-card border border-outline-strong bg-raised p-5 shadow-xl"
        >
          <div className="mb-4 flex items-center justify-between gap-2 border-b border-outline pb-3">
            <h3 className="meta text-stated-on-bg">
              {blockLabel(inspectorNode.block_name ?? "unclassified")}
            </h3>
            <button
              type="button"
              onClick={() => setInspectorId(null)}
              className="tap text-ink-invert-muted hover:text-ink-invert"
            >
              <span className="sr-only">Close inspector</span>
              <X className="mx-auto size-4" aria-hidden="true" />
            </button>
          </div>

          <div className="space-y-3">
            <p className="measure rounded-input bg-sunken p-3 text-body-sm text-ink-invert">
              {inspectorNode.content}
            </p>

            <dl className="grid grid-cols-2 gap-2">
              <Fact label="Source" value={inspectorNode.source_type} />
              <Fact label="Status" value={STATUS_CHIP[inspectorNode.status]} />
              <Fact label="Sensitivity" value={inspectorNode.sensitivity} />
              <Fact
                label="Confidence"
                value={`${Math.round(inspectorNode.confidence * 100)}%`}
              />
            </dl>

            {/* The same action bar again, rather than a second set of buttons
                that would have to be kept in step with it (§2). */}
            {inspectorItem && (
              <div className="border-t border-outline pt-3">
                <MemoryActionBar
                  item={inspectorItem}
                  onLight={false}
                  compact
                  onRequestDelete={(it) => {
                    onRequestDelete(it);
                    setInspectorId(null);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------- context menu */}
      {contextMenu && (
        <div
          role="menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 w-52 rounded-card border border-outline-strong bg-raised p-1.5 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setInspectorId(contextMenu.id);
              setContextMenu(null);
            }}
            className="tap flex w-full items-center gap-2 rounded-input px-2.5 text-left text-body-sm text-ink-invert hover:bg-sunken"
          >
            <Layers className="size-4" aria-hidden="true" /> Inspect
          </button>
          {items.some((i) => i.id === contextMenu.id) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const it = items.find((i) => i.id === contextMenu.id);
                setContextMenu(null);
                if (it) onRequestDelete(it);
              }}
              className="tap flex w-full items-center gap-2 rounded-input px-2.5 text-left text-body-sm text-danger-on-bg hover:bg-danger-dim"
            >
              <Trash2 className="size-4" aria-hidden="true" /> Delete…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "meta inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3 ring-1 transition-colors duration-[var(--motion-micro)]",
        active
          ? "bg-accent text-white ring-accent"
          : "bg-sunken text-ink-invert-muted ring-outline hover:text-ink-invert",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input bg-sunken p-2">
      <dt className="meta text-ink-invert-muted">{label}</dt>
      <dd className="meta mt-0.5 text-ink-invert">{value}</dd>
    </div>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Network className="size-8 text-ink-invert-muted" aria-hidden="true" />
      <p className="text-body-md text-ink-invert">No memories to draw yet.</p>
      <p className="measure text-body-sm text-ink-invert-muted">
        Say something in the conversation and keep what comes back. Both views fill
        up together.
      </p>
      <Chip>Blocks</Chip>
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
  node: GraphNode | MemoryItem;
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
      <p className="text-body-sm text-ink-invert-muted">
        Not connected to any other memory.
      </p>
    );
  }

  return (
    <div>
      <h4 className="meta text-ink-invert-muted">
        Connected to <span className="tnum">{links.length}</span>
      </h4>
      <ul className="mt-1.5 space-y-1">
        {links.map(({ other, relation, outgoing }) => (
          <li key={`${other.id}-${relation}-${outgoing}`}>
            <button
              type="button"
              onClick={() => onSelect(other.id)}
              className="w-full rounded-input px-2 py-2 text-left text-body-sm text-ink-invert hover:bg-sunken"
              aria-label={`${outgoing ? "This" : other.content} ${RELATION_LABEL[relation] ?? relation} ${outgoing ? other.content : "this"}. ${describeMemory(other)}`}
            >
              <span className="meta mr-2 text-ink-invert-muted">
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
