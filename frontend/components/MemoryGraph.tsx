"use client";

import React, { useEffect, useState, useMemo } from "react";
import {
  api,
  type MemoryItem,
  type MemorySubnode,
  type NodeSummaryResponse,
} from "@/lib/api";

interface MemoryGraphProps {
  memories: MemoryItem[];
  relevanceScores?: Record<string, number>;
  onSelectMemoryForChat?: (memory: MemoryItem) => void;
  onSelectMultipleMemoriesForChat?: (memories: MemoryItem[]) => void;
  onRedirectToChat?: (chatId: string) => void;
  onRefreshMemories?: () => void;
}

interface NodePosition {
  x: number;
  y: number;
}

const CATEGORY_COLORS: Record<string, { bg: string; border: string; glow: string; text: string }> = {
  Work: { bg: "#78350F", border: "#F59E0B", glow: "rgba(245, 158, 11, 0.6)", text: "#FDE68A" },
  Personal: { bg: "#831843", border: "#EC4899", glow: "rgba(236, 72, 153, 0.6)", text: "#FBCFE8" },
  Health: { bg: "#7F1D1D", border: "#EF4444", glow: "rgba(239, 68, 68, 0.6)", text: "#FCA5A5" },
  Technical: { bg: "#1E3A8A", border: "#3B82F6", glow: "rgba(59, 130, 246, 0.6)", text: "#BFDBFE" },
  General: { bg: "#312E81", border: "#6366F1", glow: "rgba(99, 102, 241, 0.6)", text: "#C7D2FE" },
  Session: { bg: "#334155", border: "#94A3B8", glow: "rgba(148, 163, 184, 0.6)", text: "#E2E8F0" },
};

function getCategoryColor(blockName: string | null, scope: string) {
  if (scope === "session") return CATEGORY_COLORS.Session;
  if (!blockName) return CATEGORY_COLORS.General;
  return CATEGORY_COLORS[blockName] || CATEGORY_COLORS.General;
}

export function MemoryGraph({
  memories,
  relevanceScores = {},
  onSelectMemoryForChat,
  onSelectMultipleMemoriesForChat,
  onRedirectToChat,
  onRefreshMemories,
}: MemoryGraphProps) {
  // Graph state
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [subnodesMap, setSubnodesMap] = useState<Record<string, MemorySubnode[]>>({});
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  
  // Multi-selection state
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());

  // Editing & Summary Modals
  const [activeItemForEdit, setActiveItemForEdit] = useState<MemoryItem | null>(null);
  const [subnodeInputContent, setSubnodeInputContent] = useState("");
  const [editingSubnodeId, setEditingSubnodeId] = useState<string | null>(null);
  const [editSubnodeText, setEditSubnodeText] = useState("");
  const [pruneMessage, setPruneMessage] = useState<string | null>(null);

  const [activeItemForSummary, setActiveItemForSummary] = useState<MemoryItem | null>(null);
  const [summaryData, setSummaryData] = useState<NodeSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Compute layout positions for nodes
  const nodePositions = useMemo(() => {
    const positions: Record<string, NodePosition> = {};
    const total = memories.length;
    if (total === 0) return positions;

    const width = 720;
    const height = 480;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.32;

    memories.forEach((mem, index) => {
      const angle = (index / total) * 2 * Math.PI - Math.PI / 2;
      positions[mem.id] = {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      };
    });

    return positions;
  }, [memories]);

  // Load subnodes when node is expanded
  const toggleNodeExpansion = async (itemId: string) => {
    const next = new Set(expandedNodeIds);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
      if (!subnodesMap[itemId]) {
        try {
          const subs = await api.getSubnodes(itemId);
          setSubnodesMap((prev) => ({ ...prev, [itemId]: subs }));
        } catch {
          // Ignore transient error
        }
      }
    }
    setExpandedNodeIds(next);
  };

  // Node selection handler
  const handleNodeClick = (mem: MemoryItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (multiSelectMode) {
      const next = new Set(selectedNodeIds);
      if (next.has(mem.id)) next.delete(mem.id);
      else next.add(mem.id);
      setSelectedNodeIds(next);
    } else {
      toggleNodeExpansion(mem.id);
    }
  };

  // Open Edit Modal
  const openEditModal = async (mem: MemoryItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveItemForEdit(mem);
    setPruneMessage(null);
    try {
      const subs = await api.getSubnodes(mem.id);
      setSubnodesMap((prev) => ({ ...prev, [mem.id]: subs }));
    } catch {
      // Ignore
    }
  };

  // Add Subnode
  const handleAddSubnode = async () => {
    if (!activeItemForEdit || !subnodeInputContent.trim()) return;
    try {
      const newSub = await api.createSubnode(
        activeItemForEdit.id,
        subnodeInputContent.trim(),
        0.9,
        activeItemForEdit.block_name || "General"
      );
      setSubnodesMap((prev) => ({
        ...prev,
        [activeItemForEdit.id]: [...(prev[activeItemForEdit.id] || []), newSub],
      }));
      setSubnodeInputContent("");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add subnode");
    }
  };

  // Delete Subnode
  const handleDeleteSubnode = async (subnodeId: string) => {
    if (!activeItemForEdit) return;
    try {
      await api.deleteSubnode(subnodeId);
      setSubnodesMap((prev) => ({
        ...prev,
        [activeItemForEdit.id]: (prev[activeItemForEdit.id] || []).filter((s) => s.id !== subnodeId),
      }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete subnode");
    }
  };

  // Save edited subnode
  const handleSaveSubnodeEdit = async (subnodeId: string) => {
    if (!activeItemForEdit || !editSubnodeText.trim()) return;
    try {
      const updated = await api.editSubnode(subnodeId, { content: editSubnodeText.trim() });
      setSubnodesMap((prev) => ({
        ...prev,
        [activeItemForEdit.id]: (prev[activeItemForEdit.id] || []).map((s) =>
          s.id === subnodeId ? updated : s
        ),
      }));
      setEditingSubnodeId(null);
      setEditSubnodeText("");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to edit subnode");
    }
  };

  // Prune Subnodes
  const handlePruneSubnodes = async () => {
    if (!activeItemForEdit) return;
    try {
      const res = await api.pruneSubnodes(activeItemForEdit.id);
      setPruneMessage(res.message);
      const subs = await api.getSubnodes(activeItemForEdit.id);
      setSubnodesMap((prev) => ({ ...prev, [activeItemForEdit.id]: subs }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to prune subnodes");
    }
  };

  // Open Summary Modal
  const openSummaryModal = async (mem: MemoryItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveItemForSummary(mem);
    setSummaryLoading(true);
    try {
      const summary = await api.getNodeSummary(mem.id);
      setSummaryData(summary);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load node summary");
    } finally {
      setSummaryLoading(false);
    }
  };

  // Trigger multi-select chat
  const handleAskSelected = () => {
    if (!onSelectMultipleMemoriesForChat) return;
    const selectedMemories = memories.filter((m) => selectedNodeIds.has(m.id));
    onSelectMultipleMemoriesForChat(selectedMemories);
  };

  return (
    <div className="relative flex flex-col w-full h-full bg-[#13131b] border border-slate-800 rounded-xl overflow-hidden shadow-2xl text-slate-200 select-none">
      {/* Visual Header / Controls */}
      <div className="flex items-center justify-between px-5 py-3 bg-[#191924] border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
          <h2 className="font-semibold text-sm tracking-wide text-white uppercase font-mono">
            Dynamic Synaptic Memory Graph
          </h2>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {/* Multi-select toggle */}
          <button
            onClick={() => {
              setMultiSelectMode(!multiSelectMode);
              if (multiSelectMode) setSelectedNodeIds(new Set());
            }}
            className={`px-3 py-1.5 rounded-lg border transition font-medium flex items-center gap-1.5 ${
              multiSelectMode
                ? "bg-indigo-600/30 border-indigo-500 text-indigo-200 shadow-[0_0_12px_rgba(99,102,241,0.4)]"
                : "bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            <span>{multiSelectMode ? "✓ Multi-Select Active" : "Enable Multi-Select"}</span>
            {selectedNodeIds.size > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-indigo-500 text-white font-mono text-[10px]">
                {selectedNodeIds.size}
              </span>
            )}
          </button>

          {/* Legend */}
          <div className="hidden sm:flex items-center gap-4 text-[11px] text-slate-400 pl-3 border-l border-slate-700">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-0.5 bg-slate-300" /> Permanent
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-0.5 border-b border-dashed border-slate-400" /> Temporary
            </span>
          </div>
        </div>
      </div>

      {/* Floating Action Bar for Multi-Select */}
      {multiSelectMode && selectedNodeIds.size > 0 && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 bg-indigo-950/90 border border-indigo-500/50 backdrop-blur-md rounded-full shadow-2xl animate-fade-in">
          <span className="text-xs font-medium text-indigo-200 font-mono">
            {selectedNodeIds.size} nodes selected
          </span>
          <button
            onClick={handleAskSelected}
            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-full transition shadow-md"
          >
            Ask AI on Selected Nodes →
          </button>
          <button
            onClick={() => setSelectedNodeIds(new Set())}
            className="text-xs text-indigo-300 hover:text-white px-2"
          >
            Clear
          </button>
        </div>
      )}

      {/* Graph Visual Canvas */}
      <div className="relative flex-1 min-h-[480px] w-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900/60 via-[#13131b] to-[#0d0d15] overflow-hidden">
        {/* SVG Connections Overlay */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
          <defs>
            <linearGradient id="gradient-solid" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8083ff" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#4edea3" stopOpacity="0.8" />
            </linearGradient>
          </defs>

          {/* Central Connecting Lines between main nodes */}
          {memories.map((mem, i) => {
            const posA = nodePositions[mem.id];
            if (!posA) return null;

            // Connect adjacent nodes to form network ring
            const nextMem = memories[(i + 1) % memories.length];
            const posB = nodePositions[nextMem.id];
            if (!posB || memories.length <= 1) return null;

            const isPersistent = mem.scope === "persistent" && nextMem.scope === "persistent";
            const isHovered = hoveredNodeId === mem.id || hoveredNodeId === nextMem.id;

            return (
              <line
                key={`edge-${mem.id}-${nextMem.id}`}
                x1={posA.x}
                y1={posA.y}
                x2={posB.x}
                y2={posB.y}
                stroke={isHovered ? "#c0c1ff" : "#334155"}
                strokeWidth={isHovered ? 2.5 : 1.2}
                strokeDasharray={isPersistent ? "none" : "4 4"}
                opacity={isHovered ? 0.9 : 0.4}
                className="transition-all duration-300"
              />
            );
          })}

          {/* Expanded Subnodes Burst Connection Paths */}
          {Array.from(expandedNodeIds).map((mainId) => {
            const mainPos = nodePositions[mainId];
            const subnodes = subnodesMap[mainId] || [];
            if (!mainPos || subnodes.length === 0) return null;

            const subRadius = 85;
            const subCount = subnodes.length;

            return subnodes.map((sub, sIdx) => {
              const subAngle = (sIdx / subCount) * 2 * Math.PI;
              const subX = mainPos.x + subRadius * Math.cos(subAngle);
              const subY = mainPos.y + subRadius * Math.sin(subAngle);

              return (
                <g key={`sub-path-group-${sub.id}`}>
                  <line
                    x1={mainPos.x}
                    y1={mainPos.y}
                    x2={subX}
                    y2={subY}
                    stroke="#8083ff"
                    strokeWidth={1.8}
                    strokeDasharray="2 2"
                    opacity={0.8}
                    className="animate-pulse"
                  />
                </g>
              );
            });
          })}
        </svg>

        {/* Nodes Layer */}
        <div className="absolute inset-0 z-10 pointer-events-auto">
          {memories.map((mem) => {
            const pos = nodePositions[mem.id];
            if (!pos) return null;

            const colors = getCategoryColor(mem.block_name, mem.scope);
            const isExpanded = expandedNodeIds.has(mem.id);
            const isSelected = selectedNodeIds.has(mem.id);
            const relevance = relevanceScores[mem.id] || 0;
            const isHovered = hoveredNodeId === mem.id;

            const subnodes = subnodesMap[mem.id] || [];

            return (
              <div key={mem.id}>
                {/* Main Memory Node */}
                <div
                  style={{
                    left: `${pos.x}px`,
                    top: `${pos.y}px`,
                    borderColor: isSelected ? "#38bdf8" : colors.border,
                    backgroundColor: colors.bg,
                    boxShadow:
                      relevance > 0
                        ? `0 0 ${12 + relevance * 24}px ${colors.glow}, inset 0 0 10px ${colors.glow}`
                        : isHovered
                        ? `0 0 16px ${colors.glow}`
                        : "0 4px 12px rgba(0,0,0,0.5)",
                    transform: `translate(-50%, -50%) scale(${isHovered ? 1.12 : isSelected ? 1.08 : 1})`,
                  }}
                  onClick={(e) => handleNodeClick(mem, e)}
                  onMouseEnter={() => setHoveredNodeId(mem.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  className={`absolute group cursor-pointer rounded-full flex flex-col items-center justify-center p-3 transition-all duration-300 z-20 border-2 w-28 h-28 text-center`}
                >
                  {/* Scope Badge indicator */}
                  <div
                    className={`absolute -top-1.5 px-2 py-0.5 rounded-full text-[9px] font-mono uppercase tracking-wider font-bold shadow-sm ${
                      mem.scope === "persistent"
                        ? "bg-emerald-500 text-black"
                        : "bg-slate-700 text-slate-200 border border-slate-500"
                    }`}
                  >
                    {mem.scope === "persistent" ? "PERM" : "TEMP"}
                  </div>

                  {/* Multi-Select Checkmark */}
                  {multiSelectMode && (
                    <div
                      className={`absolute top-1 right-1 w-5 h-5 rounded-full border flex items-center justify-center text-xs font-bold ${
                        isSelected
                          ? "bg-sky-400 border-sky-200 text-slate-950"
                          : "border-slate-500 bg-slate-900/80 text-transparent"
                      }`}
                    >
                      ✓
                    </div>
                  )}

                  {/* Content Preview */}
                  <span
                    className="text-[11px] font-semibold line-clamp-2 px-1 leading-snug"
                    style={{ color: colors.text }}
                  >
                    {mem.content}
                  </span>

                  {/* Category Pill */}
                  <span className="mt-1 text-[9px] font-mono px-2 py-0.5 rounded bg-black/40 text-slate-300">
                    {mem.block_name || "General"}
                  </span>

                  {/* Relevance Indicator Glow Ring */}
                  {relevance > 0 && (
                    <div
                      className="absolute -inset-1.5 rounded-full border-2 border-emerald-400 opacity-60 pointer-events-none animate-pulse"
                    />
                  )}

                  {/* Hover Quick Action Card */}
                  {isHovered && !multiSelectMode && (
                    <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/95 border border-slate-700 backdrop-blur-md rounded-xl shadow-2xl text-[11px] whitespace-nowrap">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onSelectMemoryForChat) onSelectMemoryForChat(mem);
                        }}
                        className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition"
                      >
                        💬 Ask Node
                      </button>

                      <button
                        onClick={(e) => openEditModal(mem, e)}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-600 transition"
                      >
                        ✏️ Edit
                      </button>

                      <button
                        onClick={(e) => openSummaryModal(mem, e)}
                        className="px-2 py-1 bg-amber-600/80 hover:bg-amber-500 text-white rounded-lg transition"
                      >
                        ⚡ Summary
                      </button>

                      {mem.session_chat_id && onRedirectToChat && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRedirectToChat(mem.session_chat_id!);
                          }}
                          className="px-2 py-1 bg-emerald-700/80 hover:bg-emerald-600 text-white rounded-lg transition"
                        >
                          🔗 Origin Chat
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Burst Subnodes */}
                {isExpanded &&
                  subnodes.map((sub, sIdx) => {
                    const subRadius = 85;
                    const subCount = subnodes.length;
                    const subAngle = (sIdx / subCount) * 2 * Math.PI;
                    const subX = pos.x + subRadius * Math.cos(subAngle);
                    const subY = pos.y + subRadius * Math.sin(subAngle);

                    return (
                      <div
                        key={sub.id}
                        style={{
                          left: `${subX}px`,
                          top: `${subY}px`,
                          transform: "translate(-50%, -50%)",
                        }}
                        className="absolute z-30 flex items-center justify-center p-2 rounded-lg bg-slate-900/90 border border-indigo-400/60 shadow-lg w-24 text-center group/sub"
                      >
                        <span className="text-[10px] text-slate-200 line-clamp-2 leading-tight">
                          {sub.content}
                        </span>
                        <div className="absolute -bottom-4 hidden group-hover/sub:flex items-center gap-1 bg-slate-950 px-2 py-0.5 rounded text-[9px] font-mono text-indigo-300 border border-slate-700">
                          conf: {(sub.confidence * 100).toFixed(0)}%
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Node Subnodes Editor Modal */}
      {activeItemForEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-[#191924] border border-slate-700 rounded-2xl p-6 shadow-2xl flex flex-col gap-4 text-slate-200 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="font-bold text-base text-white">Node & Subnodes Inspector</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  Category: {activeItemForEdit.block_name || "General"} | Scope: {activeItemForEdit.scope}
                </p>
              </div>
              <button
                onClick={() => setActiveItemForEdit(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {/* Main Node Content */}
            <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800 text-xs">
              <span className="text-slate-400 font-mono text-[10px] block mb-1">MAIN NODE CONTENT</span>
              <p className="text-slate-100 font-medium">{activeItemForEdit.content}</p>
            </div>

            {/* Prune Status Notification */}
            {pruneMessage && (
              <div className="p-3 rounded-lg bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 text-xs font-mono">
                {pruneMessage}
              </div>
            )}

            {/* Subnodes List */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300 font-mono">
                  SUBNODES ({subnodesMap[activeItemForEdit.id]?.length || 0})
                </span>
                <button
                  onClick={handlePruneSubnodes}
                  className="px-2.5 py-1 text-[11px] bg-red-900/40 hover:bg-red-800/60 text-red-300 border border-red-700/50 rounded-lg transition font-mono"
                >
                  ⚡ Prune Subnodes
                </button>
              </div>

              {(subnodesMap[activeItemForEdit.id] || []).length === 0 ? (
                <div className="text-xs text-slate-500 italic py-3 text-center">
                  No subnodes yet. Add one below.
                </div>
              ) : (
                (subnodesMap[activeItemForEdit.id] || []).map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center justify-between p-2.5 bg-slate-900/60 border border-slate-800 rounded-xl text-xs gap-3"
                  >
                    {editingSubnodeId === sub.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          type="text"
                          value={editSubnodeText}
                          onChange={(e) => setEditSubnodeText(e.target.value)}
                          className="flex-1 px-2 py-1 bg-slate-800 border border-indigo-500 rounded text-xs text-white outline-none"
                        />
                        <button
                          onClick={() => handleSaveSubnodeEdit(sub.id)}
                          className="px-2 py-1 bg-indigo-600 text-white rounded text-xs font-medium"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingSubnodeId(null)}
                          className="px-2 py-1 bg-slate-800 text-slate-400 rounded text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-col flex-1">
                          <span className="text-slate-200">{sub.content}</span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            confidence: {(sub.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              setEditingSubnodeId(sub.id);
                              setEditSubnodeText(sub.content);
                            }}
                            className="px-2 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteSubnode(sub.id)}
                            className="px-2 py-1 text-[11px] bg-red-950 hover:bg-red-900 text-red-400 rounded"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Add New Subnode Input */}
            <div className="flex items-center gap-2 mt-2 pt-3 border-t border-slate-800">
              <input
                type="text"
                placeholder="Type new subnode text..."
                value={subnodeInputContent}
                onChange={(e) => setSubnodeInputContent(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSubnode()}
                className="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-500 focus:border-indigo-500 outline-none"
              />
              <button
                onClick={handleAddSubnode}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-xl transition"
              >
                Add Subnode
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Node Summary Modal */}
      {activeItemForSummary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[#191924] border border-slate-700 rounded-2xl p-6 shadow-2xl flex flex-col gap-4 text-slate-200">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-base text-amber-400 flex items-center gap-2">
                <span>⚡</span> AI Node Summary
              </h3>
              <button
                onClick={() => setActiveItemForSummary(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {summaryLoading ? (
              <div className="py-8 text-center text-xs text-slate-400 font-mono animate-pulse">
                Synthesizing node context & subnodes...
              </div>
            ) : summaryData ? (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-slate-200 leading-relaxed bg-slate-900/80 p-3 rounded-xl border border-slate-800">
                  {summaryData.summary}
                </p>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider font-semibold">
                    Key Fact Highlights:
                  </span>
                  <ul className="space-y-1 pl-4 list-disc text-xs text-slate-300">
                    {summaryData.key_points.map((pt, idx) => (
                      <li key={idx}>{pt}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-500">Failed to load summary.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
