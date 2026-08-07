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
  id: string;
  type: "root" | "category" | "memory";
  label?: string;
  category?: string;
  count?: number;
  memory?: GraphNode;
  expanded?: boolean;
  hasChildren?: boolean;
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

export const groupOf = (n: GraphNode) => n.block_name ?? "unclassified";

export interface HierarchicalNodeData {
  id: string;
  type: "root" | "category" | "memory";
  label: string;
  category?: string;
  count?: number;
  memory?: GraphNode;
  expanded?: boolean;
  hasChildren?: boolean;
}

export const DEFAULT_CATEGORIES = [
  "Personal",
  "Work",
  "Projects",
  "Preferences",
  "Health",
  "Learning",
  "General",
];

export function buildHierarchicalGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expandedNodes: Set<string>,
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
    const cat = groupOf(n);
    const normalizedCat =
      cat.toLowerCase() === "unclassified" ? "General" : cat;
    const existing = categoryMap.get(normalizedCat) ?? [];
    existing.push(n);
    categoryMap.set(normalizedCat, existing);
  }

  const activeCategories = new Set([
    ...DEFAULT_CATEGORIES,
    ...categoryMap.keys(),
  ]);

  for (const cat of activeCategories) {
    const catMemories = categoryMap.get(cat) ?? [];
    const catId = `cat_${cat}`;
    const catExpanded = expandedNodes.has(catId);

    hNodes.push({
      id: catId,
      type: "category",
      label: cat,
      category: cat,
      count: catMemories.length,
      expanded: catExpanded,
      hasChildren: catMemories.length > 0,
    });

    hEdges.push({
      id: `e_root_${catId}`,
      source: "root_you",
      target: catId,
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
          category: cat,
          memory: mem,
          expanded: memExpanded,
          hasChildren: childEdges.length > 0,
        });

        hEdges.push({
          id: `e_${catId}_${mem.id}`,
          source: catId,
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

export function layoutHierarchicalGraph(
  hNodes: HierarchicalNodeData[],
  hEdges: PositionedEdge[],
): LayoutResult {
  const nodeMap = new Map<string, PositionedNode>();

  const centerX = 600;
  const centerY = 400;

  const root = hNodes.find((n) => n.type === "root");
  if (root) {
    nodeMap.set(root.id, { ...root, x: centerX, y: centerY, unconnected: false });
  }

  const categories = hNodes.filter((n) => n.type === "category");
  const catCount = categories.length;
  const catRadius = 240;

  categories.forEach((cat, idx) => {
    const angle = (2 * Math.PI * idx) / Math.max(1, catCount) - Math.PI / 2;
    const cx = centerX + catRadius * Math.cos(angle);
    const cy = centerY + catRadius * Math.sin(angle);
    nodeMap.set(cat.id, { ...cat, x: cx, y: cy, unconnected: false });

    const catMemories = hNodes.filter(
      (n) => n.type === "memory" && n.category === cat.category,
    );

    const memCount = catMemories.length;
    const memRadius = 180;
    const spreadAngle = Math.min(Math.PI / 1.5, Math.max(Math.PI / 4, memCount * 0.25));

    catMemories.forEach((mem, mIdx) => {
      const offsetAngle =
        memCount === 1
          ? angle
          : angle - spreadAngle / 2 + (spreadAngle * mIdx) / (memCount - 1);
      const mx = cx + memRadius * Math.cos(offsetAngle);
      const my = cy + memRadius * Math.sin(offsetAngle);
      nodeMap.set(mem.id, { ...mem, x: mx, y: my, unconnected: false });
    });
  });

  const positioned = Array.from(nodeMap.values());

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  positioned.forEach((n) => {
    minX = Math.min(minX, n.x - 120);
    minY = Math.min(minY, n.y - 60);
    maxX = Math.max(maxX, n.x + 120);
    maxY = Math.max(maxY, n.y + 60);
  });

  return {
    nodes: positioned,
    edges: hEdges,
    width: Math.max(1200, maxX - minX),
    height: Math.max(800, maxY - minY),
  };
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

