// Typed client for the FastAPI backend.
//
// The unions below are hand-mirrored from backend/app/models.py, which is mirrored
// from migrations/001_init.sql. Three places, one vocabulary (CLAUDE.md "Core
// concepts") — a rename is deliberately a three-file change, not silent drift.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000";

export type SourceType = "stated" | "inferred";

export type AssertionStatus =
  | "in_progress"
  | "completed"
  | "planned"
  | "abandoned"
  | "hypothetical"
  | "third_party";

export type Sensitivity = "low" | "medium" | "high" | "special_category";
export type Scope = "session" | "persistent";
export type ReviewState = "pending" | "accepted" | "auto_accepted" | "rejected";
export type ExtractionStatus = "skipped" | "pending" | "done" | "failed";

export interface Block {
  id: string;
  name: string;
  default_sensitivity: Sensitivity;
  restrictive_rank: number;
  is_fallback: boolean;
}

export interface MemoryItem {
  id: string;
  block_id: string | null;
  block_name: string | null;
  content: string;
  evidence: string | null;
  source_type: SourceType;
  status: AssertionStatus;
  sensitivity: Sensitivity;
  scope: Scope;
  confidence: number;
  source_message_id: string;
  session_chat_id: string | null;
  review_state: ReviewState;
  needs_review: boolean;
  review_reason: string | null;
  created_at: string;
  last_confirmed_at: string | null;
  deleted_at: string | null;
}

export interface Message {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  session_ephemeral: boolean;
  created_at: string;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
}

export interface UsedMemory {
  id: string;
  content: string;
  status: AssertionStatus;
  scope: Scope;
  sensitivity: Sensitivity;
  block_name: string | null;
  distance: number;
  is_stale: boolean;
}

export interface TurnResponse {
  user_message: Message;
  assistant_message: Message;
  used_memories: UsedMemory[];
  extraction_running: boolean;
  // Which model actually answered — not necessarily the one requested, since an
  // unconfigured or stale selection falls back on the server (D32).
  provider: string | null;
  model: string | null;
}

/** A chat provider the server has a key for. Memory is shared across all of them. */
export interface Provider {
  id: string;
  label: string;
  model: string;
  configured: boolean;
}

export interface ProvidersResponse {
  providers: Provider[];
  default: string;
}

export interface CandidatesResponse {
  status: ExtractionStatus;
  error: string | null;
  candidates: MemoryItem[];
  auto_accepted: MemoryItem[];
}

export interface RegenerateResponse {
  previous: string;
  regenerated: string;
  revoked: UsedMemory[];
  used_memories: UsedMemory[];
  assistant_message: Message;
}

export interface DraftClaim {
  text: string;
  asserted_as: AssertionStatus | null;
  sources: UsedMemory[];
  overstates: boolean;
  stale_source: boolean;
  problem: string | null;
}

export interface VerifiedDraft {
  instruction: string;
  draft: string;
  claims: DraftClaim[];
  needs_confirmation: boolean;
}

export interface Chat {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
}

export interface HiddenItem {
  id: string;
  content: string;
  block_name: string | null;
  origin_chat_title: string | null;
}

export interface ScopeReport {
  chat_id: string;
  visible_persistent: number;
  visible_session: number;
  hidden_session_items: HiddenItem[];
  ephemeral_turns: number;
  items_from_ephemeral_turns_global: number;
}

// ------------------------------------------------------- P5 provenance graph

export type EdgeRelation =
  | "derived_from"
  | "summarized_from"
  | "contradicts"
  | "updates";

/** Deliberately narrower than MemoryItem — see the backend's GraphNode. */
export interface GraphNode {
  id: string;
  content: string;
  source_type: SourceType;
  status: AssertionStatus;
  sensitivity: Sensitivity;
  scope: Scope;
  block_name: string | null;
  review_state: ReviewState;
  needs_review: boolean;
  confidence: number;
  last_confirmed_at: string | null;
  deleted_at: string | null;
}

/** `from` is the source, `to` is derived from it. Inverting this inverts the
 *  cascade, so the direction is restated here rather than inferred from a name. */
export interface GraphEdge {
  from_item_id: string;
  to_item_id: string;
  relation: EdgeRelation;
}

export interface CascadePreview {
  root_id: string;
  /** No other source. These die with the root. */
  cascade_delete: string[];
  /** Another source survives. Flagged for review — NOT re-derived (§4.5). */
  flag_for_review: string[];
  /** The other end of a contradicts/updates edge. The fact survives; the claim
   *  that the two relate loses one of its ends. */
  relationship_affected: string[];
  attribution_count: number;
}

export interface ProvenanceGraph {
  root_id: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cascade: CascadePreview | null;
  truncated: boolean;
}

export interface Health {
  status: string;
  pgvector: string | null;
  embedding_dim: number;
  live_memory_items: number;
  llm_key_loaded: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* response had no JSON body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export interface MemorySubnode {
  id: string;
  memory_item_id: string;
  content: string;
  confidence: number;
  category: string | null;
  created_at: string;
}

export interface NodeSummaryResponse {
  memory_item_id: string;
  title: string;
  summary: string;
  key_points: string[];
  subnode_count: number;
}

export interface PruneResponse {
  pruned_count: number;
  message: string;
}

export interface RelevanceResponse {
  scores: Record<string, number>;
}

export const api = {
  health: () => req<Health>("/health"),
  providers: () => req<ProvidersResponse>("/chats/providers"),
  blocks: () => req<Block[]>("/memory/blocks"),

  items: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req<MemoryItem[]>(`/memory/items${qs ? `?${qs}` : ""}`);
  },

  createChat: (title?: string) => post<Chat>("/chats", { title }),
  chats: () => req<Chat[]>("/chats"),
  messages: (chatId: string) => req<Message[]>(`/chats/${chatId}/messages`),
  scopeReport: (chatId: string) => req<ScopeReport>(`/chats/${chatId}/scope-report`),
  purgeEphemeral: (chatId: string) =>
    post<{ redacted_turns: number }>(`/chats/${chatId}/purge-ephemeral`),

  sendTurn: (
    chatId: string,
    content: string,
    sessionEphemeral: boolean,
    provider?: string,
  ) =>
    post<TurnResponse>(`/chats/${chatId}/message`, {
      content,
      session_ephemeral: sessionEphemeral,
      provider: provider || undefined,
    }),

  candidates: (chatId: string, messageId: string) =>
    req<CandidatesResponse>(
      `/chats/${chatId}/candidates?message_id=${messageId}`,
    ),

  regenerate: (chatId: string, messageId: string, revokeItemIds: string[]) =>
    post<RegenerateResponse>(`/chats/${chatId}/regenerate`, {
      message_id: messageId,
      revoke_item_ids: revokeItemIds,
    }),

  verifiedDraft: (chatId: string, instruction: string) =>
    post<VerifiedDraft>(`/chats/${chatId}/verified-draft`, { instruction }),

  /** Every live item plus every edge between them. Backs the graph view. */
  graph: () => req<ProvenanceGraph>("/memory/graph"),

  /** The deletion preview for one item, as data. Same object the DELETE returns,
   *  so what the user was shown and what the server did cannot diverge. */
  itemGraph: (id: string) => req<ProvenanceGraph>(`/memory/items/${id}/graph`),

  remove: (id: string) =>
    req<CascadePreview>(`/memory/items/${id}`, { method: "DELETE" }),

  accept: (id: string) => post<MemoryItem>(`/memory/items/${id}/accept`),
  confirm: (id: string) => post<MemoryItem>(`/memory/items/${id}/confirm`),
  reject: (id: string) => post<MemoryItem>(`/memory/items/${id}/reject`),
  rescope: (id: string, scope: Scope) =>
    post<MemoryItem>(`/memory/items/${id}/rescope`, { scope }),
  edit: (
    id: string,
    patch: Partial<{
      content: string;
      status: AssertionStatus;
      sensitivity: Sensitivity;
      block_name: string;
    }>,
  ) =>
    req<MemoryItem>(`/memory/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // Graph & Subnode API
  getSubnodes: (itemId: string) => req<MemorySubnode[]>(`/memory/items/${itemId}/subnodes`),
  createSubnode: (itemId: string, content: string, confidence = 0.9, category?: string) =>
    post<MemorySubnode>(`/memory/items/${itemId}/subnodes`, { content, confidence, category }),
  editSubnode: (subnodeId: string, patch: Partial<{ content: string; confidence: number; category: string }>) =>
    req<MemorySubnode>(`/memory/subnodes/${subnodeId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteSubnode: (subnodeId: string) =>
    req<{ status: string; id: string }>(`/memory/subnodes/${subnodeId}`, {
      method: "DELETE",
    }),
  pruneSubnodes: (itemId: string) => post<PruneResponse>(`/memory/items/${itemId}/prune`),
  getNodeSummary: (itemId: string) => req<NodeSummaryResponse>(`/memory/items/${itemId}/summary`),
  computeRelevance: (prompt: string) => post<RelevanceResponse>("/memory/relevance", { prompt }),
};

// ---------------------------------------------------------------- labels
// User-facing wording lives here, not scattered through components. The vocabulary
// is exact in the data model and plain in the interface — "in progress", not
// "in_progress", and never a raw enum on screen.

export const STATUS_LABEL: Record<AssertionStatus, string> = {
  in_progress: "in progress",
  completed: "completed",
  planned: "planned",
  abandoned: "abandoned",
  hypothetical: "hypothetical",
  third_party: "about someone else",
};

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  low: "low",
  medium: "medium",
  high: "sensitive",
  special_category: "special category",
};

export const SCOPE_LABEL: Record<Scope, string> = {
  session: "this chat only",
  persistent: "remembered",
};
