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

export interface PositionedNode {
  node: GraphNode;
  x: number;
  y: number;
  /** Isolated nodes get their own grid; the flag lets the view say so. */
  unconnected: boolean;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/**
 * Group label for a node. Blocks are the user-facing grouping (CLAUDE.md core
 * concepts), so they are what the layout clusters by when it needs to cluster.
 */
export const groupOf = (n: GraphNode) => n.block_name ?? "unclassified";

/**
 * Lay out a provenance graph.
 *
 * Two regions, because most memories in this system have no provenance edge at
 * all yet (`memory_edges` is written by nothing — PHASES.md P5). Running every
 * isolated node through dagre produces one long meaningless row, so:
 *
 *   - nodes with at least one edge go through dagre, top-down, and read as the
 *     derivation structure they are;
 *   - isolated nodes are laid out in a stable grid beneath, sorted by block then
 *     content, which is a deliberately boring arrangement — it is a legible
 *     inventory, not a claim that they relate.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): LayoutResult {
  // Sort first, and by id last, so ties never fall through to insertion order.
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
    // `rankdir: TB` puts sources above what was derived from them, which matches
    // the direction the cascade actually flows. Reading down the page is reading
    // toward the consequences of a delete.
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
      // dagre centres; React Flow positions from the top-left corner.
      positioned.push({
        node: n,
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
      positioned.push({ node: n, x, y, unconnected: true });
      width = Math.max(width, x + NODE_W);
      height = Math.max(height, y + NODE_H);
    });
  }

  return { nodes: positioned, edges: liveEdges, width, height };
}

/**
 * §3.2: "Arrow-key navigation between connected nodes."
 *
 * Builds an adjacency map in stable order so pressing the same key twice from
 * the same node always lands in the same place. Undirected on purpose — a user
 * walking the graph wants to get back to where they came from, and making the
 * return trip require a different key would be a puzzle, not navigation.
 */
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
