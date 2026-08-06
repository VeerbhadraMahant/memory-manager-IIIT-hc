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
}

export interface TurnResponse {
  user_message: Message;
  assistant_message: Message;
  used_memories: UsedMemory[];
  extraction_running: boolean;
}

export interface CandidatesResponse {
  status: ExtractionStatus;
  error: string | null;
  candidates: MemoryItem[];
  auto_accepted: MemoryItem[];
}

export interface Health {
  status: string;
  pgvector: string | null;
  embedding_dim: number;
  live_memory_items: number;
  gemini_key_loaded: boolean;
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

export const api = {
  health: () => req<Health>("/health"),
  blocks: () => req<Block[]>("/memory/blocks"),

  items: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req<MemoryItem[]>(`/memory/items${qs ? `?${qs}` : ""}`);
  },

  createChat: (title?: string) => post<{ id: string }>("/chats", { title }),

  sendTurn: (chatId: string, content: string, sessionEphemeral: boolean) =>
    post<TurnResponse>(`/chats/${chatId}/message`, {
      content,
      session_ephemeral: sessionEphemeral,
    }),

  candidates: (chatId: string, messageId: string) =>
    req<CandidatesResponse>(
      `/chats/${chatId}/candidates?message_id=${messageId}`,
    ),

  accept: (id: string) => post<MemoryItem>(`/memory/items/${id}/accept`),
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
