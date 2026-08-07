// §3.1 — deterministic layout. This is the non-negotiable one.
//
// "Same data → same positions, every render. Force-directed layouts move nodes
// on every mount, which destroys spatial memory *and* makes your demo
// unrepeatable on stage."
//
// dagre is deterministic given deterministic input, and that qualifier is the
// whole trick: dagre iterates over its internal node map, so the order nodes are
// *added* in decides the layout. Feeding it `graph.nodes` straight from the API
// would make positions depend on the database's row order, which is stable until
// the day it isn't. Everything below is sorted before it is inserted.
//
// The verification for this is §8.7: reload five times, positions identical.

import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "./api";
import { blockKey, blockLabel } from "./semantics";

// Fixed, not minimum. React Flow measures unsized nodes from the DOM, and
// fitView runs against whatever it has measured *so far* — which on the first
// paint is a subset, so the graph opened zoomed in on a corner. Declaring the
// box means the layout, the node and the fit all agree from frame one, and it
// is also what makes the layout deterministic in the first place: a node whose
// height depends on how its text wrapped is a node whose position does too.
//
// 108 = 8+8 padding + 16 label row + 6 gap + 40 two clamped lines of body-sm
//       + 6 gap + 16 status row, with the remainder as slack.
export const NODE_W = 216;
export const NODE_H = 108;

/** §3.4: above ~150 nodes the graph is unreadable. */
export const NODE_CAP = 150;

export const ROOT_W = 96;
export const ROOT_H = 96;
export const CAT_W = 200;
export const CAT_H = 56;

/** Box for a node of each kind. The layout, React Flow and the component all
 *  read this, so a node can never be positioned as one size and drawn as
 *  another — which is how the cards ended up overlapping. */
export function nodeBox(type: "root" | "category" | "memory") {
  if (type === "root") return { width: ROOT_W, height: ROOT_H };
  if (type === "category") return { width: CAT_W, height: CAT_H };
  return { width: NODE_W, height: NODE_H };
}

export interface PositionedNode {
  id: string;
  type: "root" | "category" | "memory";
  label?: string;
  /** Canonical (lowercase) block key. What the API is given. */
  category?: string;
  /** Display-cased block name. What a human reads. */
  categoryLabel?: string;
  count?: number;
  memory?: GraphNode;
  expanded?: boolean;
  hasChildren?: boolean;
  /** A block node with nothing in it. Rendered recessive, never like a full one. */
  empty?: boolean;
  x: number;
  y: number;
  unconnected: boolean;
}

export interface PositionedEdge {
  id: string;
  source: string;
  target: string;
  relation?: string;
  provisional?: boolean;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

/** Canonical block key for a memory. Lowercase, so `work` and `Work` are one
 *  block rather than two nodes with the same meaning. */
export const groupOf = (n: GraphNode) => blockKey(n.block_name ?? "unclassified");

export interface HierarchicalNodeData {
  id: string;
  type: "root" | "category" | "memory";
  label: string;
  category?: string;
  categoryLabel?: string;
  count?: number;
  memory?: GraphNode;
  expanded?: boolean;
  hasChildren?: boolean;
  empty?: boolean;
}

export const catId = (key: string) => `cat_${blockKey(key)}`;

/**
 * Which block nodes the graph draws, in a stable order.
 *
 * Derived from the blocks the backend actually has plus whatever the memories
 * reference — never from a hardcoded list. A hardcoded list is what put
 * `Projects 0` and `Preferences 0` next to `work 18`: invented blocks that no
 * item could ever land in, rendered identically to the real ones.
 */
export function categoryKeys(
  knownBlocks: readonly string[],
  nodes: readonly GraphNode[],
): string[] {
  const keys = new Set<string>();
  for (const b of knownBlocks) keys.add(blockKey(b));
  for (const n of nodes) keys.add(groupOf(n));
  return [...keys].sort();
}

export function buildHierarchicalGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expandedNodes: Set<string>,
  knownBlocks: readonly string[] = [],
): {
  hNodes: HierarchicalNodeData[];
  hEdges: PositionedEdge[];
} {
  const hNodes: HierarchicalNodeData[] = [];
  const hEdges: PositionedEdge[] = [];

  const rootExpanded = expandedNodes.has("root_you");
  hNodes.push({
    id: "root_you",
    type: "root",
    label: "YOU",
    expanded: rootExpanded,
    hasChildren: true,
  });

  if (!rootExpanded) {
    return { hNodes, hEdges };
  }

  const categoryMap = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const key = groupOf(n);
    const existing = categoryMap.get(key) ?? [];
    existing.push(n);
    categoryMap.set(key, existing);
  }

  for (const key of categoryKeys(knownBlocks, nodes)) {
    // Sorted so the layout is a function of the data, not of row order (§3.1).
    const catMemories = [...(categoryMap.get(key) ?? [])].sort(
      (a, b) => a.content.localeCompare(b.content) || a.id.localeCompare(b.id),
    );
    const id = catId(key);
    const catExpanded = expandedNodes.has(id);

    hNodes.push({
      id,
      type: "category",
      label: blockLabel(key),
      category: key,
      categoryLabel: blockLabel(key),
      count: catMemories.length,
      expanded: catExpanded,
      hasChildren: catMemories.length > 0,
      empty: catMemories.length === 0,
    });

    hEdges.push({
      id: `e_root_${id}`,
      source: "root_you",
      target: id,
      relation: "contains",
      provisional: false,
    });

    if (catExpanded) {
      for (const mem of catMemories) {
        const memExpanded = expandedNodes.has(mem.id);
        const childEdges = edges.filter((e) => e.from_item_id === mem.id);

        hNodes.push({
          id: mem.id,
          type: "memory",
          label: mem.content,
          category: key,
          categoryLabel: blockLabel(key),
          memory: mem,
          expanded: memExpanded,
          hasChildren: childEdges.length > 0,
        });

        hEdges.push({
          id: `e_${id}_${mem.id}`,
          source: id,
          target: mem.id,
          relation: "item",
          provisional: mem.scope === "session",
        });
      }
    }
  }

  const visibleMemIds = new Set(
    hNodes.filter((n) => n.type === "memory").map((n) => n.id),
  );
  for (const e of edges) {
    if (visibleMemIds.has(e.from_item_id) && visibleMemIds.has(e.to_item_id)) {
      hEdges.push({
        id: `e_prov_${e.from_item_id}_${e.to_item_id}`,
        source: e.from_item_id,
        target: e.to_item_id,
        relation: e.relation,
        provisional: e.relation === "contradicts",
      });
    }
  }

  return { hNodes, hEdges };
}

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): LayoutResult {
  const ordered = [...nodes].sort(
    (a, b) =>
      groupOf(a).localeCompare(groupOf(b)) ||
      a.content.localeCompare(b.content) ||
      a.id.localeCompare(b.id),
  );

  const present = new Set(ordered.map((n) => n.id));
  const liveEdges = [...edges]
    .filter((e) => present.has(e.from_item_id) && present.has(e.to_item_id))
    .sort(
      (a, b) =>
        a.from_item_id.localeCompare(b.from_item_id) ||
        a.to_item_id.localeCompare(b.to_item_id) ||
        a.relation.localeCompare(b.relation),
    );

  const connected = new Set<string>();
  for (const e of liveEdges) {
    connected.add(e.from_item_id);
    connected.add(e.to_item_id);
  }

  const positioned: PositionedNode[] = [];
  let width = 0;
  let height = 0;

  if (connected.size > 0) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 72, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of ordered) {
      if (connected.has(n.id)) g.setNode(n.id, { width: NODE_W, height: NODE_H });
    }
    for (const e of liveEdges) g.setEdge(e.from_item_id, e.to_item_id);

    dagre.layout(g);

    for (const n of ordered) {
      if (!connected.has(n.id)) continue;
      const p = g.node(n.id);
      positioned.push({
        id: n.id,
        type: "memory",
        memory: n,
        label: n.content,
        category: groupOf(n),
        categoryLabel: blockLabel(groupOf(n)),
        x: p.x - NODE_W / 2,
        y: p.y - NODE_H / 2,
        unconnected: false,
      });
      width = Math.max(width, p.x + NODE_W / 2);
      height = Math.max(height, p.y + NODE_H / 2);
    }
  }

  const isolated = ordered.filter((n) => !connected.has(n.id));
  if (isolated.length > 0) {
    const gap = 24;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(isolated.length))));
    const top = connected.size > 0 ? height + 96 : 24;
    isolated.forEach((n, i) => {
      const x = 24 + (i % cols) * (NODE_W + gap);
      const y = top + Math.floor(i / cols) * (NODE_H + gap);
      positioned.push({
        id: n.id,
        type: "memory",
        memory: n,
        label: n.content,
        category: groupOf(n),
        categoryLabel: blockLabel(groupOf(n)),
        x,
        y,
        unconnected: true,
      });
      width = Math.max(width, x + NODE_W);
      height = Math.max(height, y + NODE_H);
    });
  }

  const formattedEdges: PositionedEdge[] = liveEdges.map((e) => ({
    id: `${e.from_item_id}-${e.to_item_id}-${e.relation}`,
    source: e.from_item_id,
    target: e.to_item_id,
    relation: e.relation,
    provisional: e.relation === "contradicts",
  }));

  return { nodes: positioned, edges: formattedEdges, width, height };
}

/**
 * §3.1 again, and the reason the previous version had to go: the mindmap was
 * laid out by hand on a fixed 180px radius around each block, with no notion of
 * how large a node was. Any block holding more than about five memories stacked
 * its cards on top of each other, and expanded cards were placed in the same
 * free space as the block pills they belonged to.
 *
 * dagre does the same job with collision built in — it reserves each node's real
 * box, so children cannot land on their parent or on each other. Input is sorted
 * before insertion (see `categoryKeys` and the memory sort in
 * `buildHierarchicalGraph`), which is what makes the result identical on every
 * render rather than merely usually identical.
 *
 * Only the containment edges (root→block, block→memory) drive the layout.
 * Provenance edges between memories are still drawn, but letting them pull on
 * the ranking turns the tree into a tangle.
 */
export function layoutHierarchicalGraph(
  hNodes: HierarchicalNodeData[],
  hEdges: PositionedEdge[],
): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    // LR rather than TB: memory cards are 216 wide and 108 tall, so a top-down
    // tree grows sideways at ~256px per memory and is mostly empty vertically.
    // Ranking left-to-right spends the cheap axis on the many-nodes rank, which
    // roughly doubles the usable zoom in the split layout's right-hand pane.
    rankdir: "LR",
    // Generous separation: these are cards, not dots, and the complaint the
    // previous layout earned was collision, not wasted space.
    nodesep: 28,
    ranksep: 96,
    marginx: 48,
    marginy: 48,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of hNodes) g.setNode(n.id, nodeBox(n.type));

  const present = new Set(hNodes.map((n) => n.id));
  for (const e of hEdges) {
    if (e.relation !== "contains" && e.relation !== "item") continue;
    if (present.has(e.source) && present.has(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  let width = 0;
  let height = 0;
  const positioned: PositionedNode[] = hNodes.map((n) => {
    const box = nodeBox(n.type);
    const p = g.node(n.id);
    // dagre reports centres; React Flow positions by top-left.
    const x = p.x - box.width / 2;
    const y = p.y - box.height / 2;
    width = Math.max(width, x + box.width);
    height = Math.max(height, y + box.height);
    return { ...n, x, y, unconnected: false };
  });

  return { nodes: positioned, edges: hEdges, width, height };
}

export function adjacency(edges: GraphEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = map.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    map.set(a, list);
  };
  for (const e of edges) {
    add(e.from_item_id, e.to_item_id);
    add(e.to_item_id, e.from_item_id);
  }
  for (const [k, v] of map) map.set(k, [...v].sort());
  return map;
}

