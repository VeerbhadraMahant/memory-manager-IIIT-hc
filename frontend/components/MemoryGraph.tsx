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
import { Info, Network } from "lucide-react";

import type { GraphNode, MemoryItem, ProvenanceGraph } from "@/lib/api";
import { useMemoryStore } from "@/lib/memory-store";
import { NODE_CAP, NODE_H, NODE_W, adjacency, layoutGraph } from "@/lib/graph-layout";
import { RELATION_LABEL, describeMemory } from "@/lib/semantics";
import { MemoryActionBar, MemorySummary } from "@/components/MemoryActionBar";
import { MemoryNode, type MemoryNodeData } from "@/components/MemoryNode";
import { Chip } from "@/components/ui/chip";

const nodeTypes = { memory: MemoryNode };

/** Matched against the CSS media query rather than assumed — §5's reduced-motion
 *  path has to turn off fitView's animation too, which is JS, not CSS. */
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
  const { setViewport } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);

  // Memoised rather than defaulted inline: `graph?.nodes ?? []` produces a new
  // array identity on every render, which would re-run the layout — and the
  // layout is the thing §3.1 requires to be stable.
  const source = useMemo(() => graph?.nodes ?? [], [graph]);
  const rawEdges = useMemo(() => graph?.edges ?? [], [graph]);
  const capped = source.length > NODE_CAP;
  const visible = useMemo(() => source.slice(0, NODE_CAP), [source]);

  const layout = useMemo(() => layoutGraph(visible, rawEdges), [visible, rawEdges]);
  const neighbours = useMemo(() => adjacency(layout.edges), [layout.edges]);

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

  /** Move focus to a node's DOM element. The graph's keyboard model is "focus is
   *  the cursor", so navigation *is* focus movement — nothing tracks a separate
   *  highlighted-node state that could drift out of sync with the focus ring. */
  const focusNode = useCallback((id: string) => {
    canvas.current
      ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] [role="button"]`)
      ?.focus();
  }, []);

  /**
   * §3.2 arrow-key navigation between connected nodes.
   *
   * Left/Right walk the neighbour list of the current node; Up/Down do the same
   * in the other direction. Deliberately list-walking rather than geometric:
   * "the nearest node 30° up and to the left" is unpredictable to a user who
   * cannot see the canvas, and the whole point of this being real DOM is that
   * the blind path and the sighted path are the same path.
   */
  const onArrow = useCallback(
    (id: string, key: string) => {
      const linked = neighbours.get(id);
      if (linked?.length) {
        const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
        focusNode(linked[(linked.length + step) % linked.length]);
        return;
      }
      // Isolated node: fall back to walking the stable layout order, so the
      // arrow keys still do something sensible on a graph with no edges.
      const order = layout.nodes.map((p) => p.node.id);
      const at = order.indexOf(id);
      if (at === -1) return;
      const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      focusNode(order[(at + step + order.length) % order.length]);
    },
    [neighbours, layout.nodes, focusNode],
  );

  const nodes: Node<MemoryNodeData>[] = useMemo(
    () =>
      layout.nodes.map((p) => ({
        id: p.node.id,
        type: "memory",
        position: { x: p.x, y: p.y },
        // Declared, not measured. A node whose height depends on how its text
        // wrapped is a node whose position depends on it too, and §3.1 does not
        // survive that.
        width: NODE_W,
        height: NODE_H,
        // Dragging would let the user destroy the deterministic layout the whole
        // section exists to protect, and there is nothing to gain by moving a
        // node whose position is meaningful (§3.1).
        draggable: false,
        // Focus is managed on the inner element, which carries the label; a
        // second focusable wrapper would make every node two tab stops.
        focusable: false,
        data: {
          memory: p.node,
          selected: p.node.id === selectedId,
          doomed: doomed.has(p.node.id),
          degraded: degraded.has(p.node.id),
          relevance: relevance?.get(p.node.id) ?? (relevance ? 0 : null),
          unconnected: p.unconnected,
          onActivate: (id: string) => onSelect(id === selectedId ? null : id),
          onArrow,
        },
      })),
    [layout.nodes, selectedId, doomed, degraded, relevance, onSelect, onArrow],
  );

  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e) => {
        const dying = doomed.has(e.from_item_id) || doomed.has(e.to_item_id);
        // Persistence encoding from §4.1: a permanent link is a solid line, a
        // temporary one is dashed. `contradicts` is dashed too — it is a claim
        // about disagreement, not a derivation.
        const provisional = e.relation === "contradicts";
        return {
          id: `${e.from_item_id}-${e.to_item_id}-${e.relation}`,
          source: e.from_item_id,
          target: e.to_item_id,
          label: RELATION_LABEL[e.relation] ?? e.relation,
          labelShowBg: true,
          labelBgStyle: { fill: "var(--surface-sunken)" },
          labelStyle: {
            fill: "var(--ink-invert-muted)",
            fontSize: 11,
            fontFamily: "var(--font-jetbrains), monospace",
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: dying ? "var(--danger)" : "var(--outline-strong)",
          },
          style: {
            stroke: dying ? "var(--danger)" : "var(--outline-strong)",
            strokeWidth: dying ? 2.5 : 1.5,
            strokeDasharray: provisional ? "6 4" : undefined,
          },
        };
      }),
    [layout.edges, doomed],
  );

  // The initial viewport is computed here rather than delegated to fitView.
  //
  // Not a workaround — a consequence of §3.1. fitView measures whatever React
  // Flow has registered at the moment it happens to run, which on a panel that
  // mounts on a view switch is a race: it fitted to nothing and the graph opened
  // at zoom 1 in a corner. The layout already knows its own extent, so the fit
  // is arithmetic over `layout.width`/`layout.height` and the pane size. Same
  // data and same pane → same viewport, which is the guarantee §3.1 asks for and
  // the thing §8.7 checks by reloading five times.
  const [pane, setPane] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setPane((p) => (p.w === width && p.h === height ? p : { w: width, h: height }));
    };
    // A timer for the first measurement, not requestAnimationFrame, and a
    // resize listener alongside the observer. Both fallbacks exist because
    // Chrome suspends rAF *and* ResizeObserver in a background tab: without
    // them the graph renders unfitted for any viewer whose tab was not focused
    // when it mounted, which is the normal case for a second monitor.
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
    const inset = 0.9; // 5% breathing room each side
    const zoom = Math.max(
      0.2,
      Math.min(
        (pane.w * inset) / Math.max(layout.width, 1),
        (pane.h * inset) / Math.max(layout.height, 1),
        1, // never magnify past 1:1 — a three-node graph should not fill the screen
      ),
    );
    // The first fit is instant. §5: motion has to communicate a relationship or
    // a state change, and animating the arrival of a view the user has not seen
    // yet communicates nothing — it is decoration, so it gets cut. It is also
    // the robust choice: an animated viewport runs on requestAnimationFrame,
    // which Chrome suspends in a background tab, so an animated first fit never
    // arrives at all for anyone who opened the page and looked away.
    // Later re-fits *do* animate, because there the movement is the message.
    const duration = fitted.current && !reduced ? 300 : 0;
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

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedNode = visible.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      {/* 70dvh rather than a pixel height: the graph is the one surface where
          vertical room is the whole product, and a fixed height that looked
          right on a laptop is a letterbox on a projector. */}
      <div className="flex h-[70dvh] min-h-[440px] flex-1 flex-col overflow-hidden rounded-card border border-outline bg-sunken">
        {(capped || graph?.truncated) && (
          <p className="border-b border-outline bg-stated-dim px-4 py-2 text-body-sm text-stated-on-dark">
            Showing {NODE_CAP} of {source.length} memories. Above about 150 nodes
            the graph stops being readable — filter in the list view to narrow it.
          </p>
        )}

        <div ref={canvas} className="relative min-h-0 flex-1">
          {layout.nodes.length === 0 ? (
            <EmptyCanvas />
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              // The Controls' fit button stays as a manual escape hatch after
              // panning; the *initial* viewport is set above, not by fitView.
              fitViewOptions={{ padding: 0.1 }}
              // Panning and zooming stay; node dragging does not (see above).
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: false }}
              minZoom={0.2}
              maxZoom={1.6}
              onPaneClick={() => onSelect(null)}
              aria-label="Memory provenance graph"
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color="var(--outline)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        {layout.edges.length === 0 && layout.nodes.length > 0 && (
          // Said plainly rather than hidden behind a prettier empty state. The
          // gap is real and PHASES.md records it; a graph that looks connected
          // when nothing has been connected would be the lie.
          <p className="flex items-start gap-2 border-t border-outline px-4 py-3 text-body-sm text-ink-invert-muted">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              No provenance edges have been written yet. Nothing in the pipeline
              currently detects that one memory updates, contradicts or was
              derived from another, so these nodes are genuinely unconnected
              rather than laid out badly. Deletion preview reads the same edges,
              so it will report no dependents until that lands.
            </span>
          </p>
        )}
      </div>

      {/* Detail panel. The graph's actions live here, not on the node, because
          §3.3 forbids hover-only affordances and a hover popover on a node is
          exactly that. Click, Enter and tap all arrive at this same panel. */}
      <aside
        aria-label="Selected memory"
        className="on-surface w-full shrink-0 self-start rounded-card bg-surface p-4 lg:w-96"
      >
        {selected && selectedNode ? (
          <div className="space-y-3">
            <p className="text-body-md text-ink">{selected.content}</p>
            <MemorySummary item={selected} />
            {/* The lossless textual equivalent of what the graph is drawing
                around this node (principle 6). */}
            <NodeConnections
              node={selectedNode}
              graph={graph}
              onSelect={onSelect}
            />
            <div className="border-t border-outline-ink pt-3">
              <MemoryActionBar item={selected} onRequestDelete={onRequestDelete} />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <h3 className="text-headline-md text-ink">Nothing selected</h3>
            <p className="text-body-sm text-ink-muted">
              Choose a node to see what it is connected to and act on it. Tab
              reaches every node in a stable order; arrow keys walk between
              connected ones.
            </p>
            <p className="text-body-sm text-ink-muted">
              Every action here is also in the list view. Neither view is the
              fallback.
            </p>
          </div>
        )}
      </aside>
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

function EmptyCanvas() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <Network className="size-8 text-ink-invert-muted" aria-hidden="true" />
      <p className="text-body-md text-ink-invert">No memories to draw yet.</p>
      <p className="max-w-sm text-body-sm text-ink-invert-muted">
        Say something in the conversation and keep what comes back. Both views
        fill up together.
      </p>
      <Chip>graph view</Chip>
    </div>
  );
}
