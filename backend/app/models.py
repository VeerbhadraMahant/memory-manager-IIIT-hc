"""Pydantic mirrors of the DB vocabulary.

These enum values must match migrations/001_init.sql exactly. They are the shared
vocabulary from CLAUDE.md — the same words appear in the schema, the API, and the UI
labels, so a rename is a three-file change on purpose rather than a silent drift.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class SourceType(str, Enum):
    stated = "stated"
    inferred = "inferred"


class AssertionStatus(str, Enum):
    in_progress = "in_progress"
    completed = "completed"
    planned = "planned"
    abandoned = "abandoned"
    hypothetical = "hypothetical"
    third_party = "third_party"


class Sensitivity(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"
    special_category = "special_category"


class Scope(str, Enum):
    session = "session"
    persistent = "persistent"


class ReviewState(str, Enum):
    pending = "pending"
    accepted = "accepted"
    auto_accepted = "auto_accepted"
    rejected = "rejected"


class EdgeRelation(str, Enum):
    derived_from = "derived_from"
    summarized_from = "summarized_from"
    contradicts = "contradicts"
    updates = "updates"


class MessageRole(str, Enum):
    user = "user"
    assistant = "assistant"
    system = "system"


class ExtractionStatus(str, Enum):
    skipped = "skipped"
    pending = "pending"
    done = "done"
    failed = "failed"


# ------------------------------------------------------------------ chat

class ChatCreate(BaseModel):
    title: str | None = None


class ChatUpdate(BaseModel):
    """Rename. `title` is the only mutable field on a chat."""

    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        """Validate the *stripped* value, not the raw one.

        `min_length=1` alone accepts "   ", which the handler then strips to "" —
        producing a chat with a blank name in the sidebar. Stripping here means the
        length constraint and the stored value can no longer disagree.
        """
        stripped = v.strip()
        if not stripped:
            raise ValueError("title cannot be blank")
        return stripped


class Chat(BaseModel):
    id: UUID
    user_id: UUID
    title: str | None
    created_at: datetime


class ChatDeleted(BaseModel):
    """What deleting a chat actually did, so the UI reports it rather than guessing.

    Named `session_memories_removed` and `persistent_memories_kept` rather than a
    single count because the asymmetry is the point: memories confined to this chat
    go with it, memories the user promoted out of it do not (migration 006).
    """

    chat_id: UUID
    session_memories_removed: int
    persistent_memories_kept: int


class Me(BaseModel):
    """Who the request is acting as.

    Reports the real `users` row rather than echoing the configured id, so the
    sidebar's profile entry shows something true. There is no auth yet — this is
    always the demo user — and that is precisely why it reads from the database:
    when sign-in lands, this endpoint changes and the UI does not.
    """

    id: UUID
    handle: str
    created_at: datetime
    is_demo_user: bool


class MessageCreate(BaseModel):
    role: MessageRole = MessageRole.user
    content: str
    # P3: marks the turn as never eligible for extraction.
    session_ephemeral: bool = False


class Message(BaseModel):
    id: UUID
    chat_id: UUID
    role: MessageRole
    content: str
    session_ephemeral: bool
    created_at: datetime
    extraction_status: ExtractionStatus = ExtractionStatus.skipped
    extraction_error: str | None = None


# ------------------------------------------------------------------ memory

class MemoryItemCreate(BaseModel):
    content: str = Field(min_length=1)
    source_type: SourceType
    status: AssertionStatus
    sensitivity: Sensitivity
    scope: Scope = Scope.persistent
    confidence: float = Field(ge=0.0, le=1.0)
    source_message_id: UUID
    block_name: str | None = None
    # Required when scope == session; rejected when persistent. Enforced by a
    # CHECK constraint in the schema as well, so the API cannot drift from the DB.
    session_chat_id: UUID | None = None
    review_state: ReviewState = ReviewState.pending
    needs_review: bool = False


class MemoryItem(BaseModel):
    id: UUID
    user_id: UUID
    block_id: UUID | None
    block_name: str | None = None
    content: str
    # The phrase in the source message this was pulled from. Lets the review card
    # show why an item exists instead of asking the user to take it on trust.
    evidence: str | None = None
    source_type: SourceType
    status: AssertionStatus
    sensitivity: Sensitivity
    scope: Scope
    confidence: float
    source_message_id: UUID
    session_chat_id: UUID | None
    review_state: ReviewState
    needs_review: bool
    # Plain-language explanation of the disposition, shown on the review card.
    review_reason: str | None = None
    created_at: datetime
    last_confirmed_at: datetime | None
    deleted_at: datetime | None


class Block(BaseModel):
    id: UUID
    name: str
    default_sensitivity: Sensitivity
    restrictive_rank: int
    is_fallback: bool
    # Migration 007. True means retrieval excludes this block, so its memories are
    # never placed in a prompt. Distinct from scope, which controls *which chats* may
    # use a memory; this controls whether the model may see it at all.
    private: bool = False


class BlockPrivacy(BaseModel):
    private: bool


# ------------------------------------------------------- P5 provenance graph

class GraphNode(BaseModel):
    """A memory item reduced to what the graph and its text equivalent need.

    Not `MemoryItem`: the graph renders every node it returns, and shipping
    embeddings-adjacent bulk down the wire for a view that shows five fields is
    waste the node cap (guideline §3.4) exists to avoid.
    """
    id: UUID
    content: str
    source_type: SourceType
    status: AssertionStatus
    sensitivity: Sensitivity
    scope: Scope
    block_name: str | None
    review_state: ReviewState
    needs_review: bool
    confidence: float
    last_confirmed_at: datetime | None
    deleted_at: datetime | None


class GraphEdge(BaseModel):
    """Direction follows SYSTEM_DESIGN §3: `from` is the source, `to` is derived
    from it. Reversing this silently inverts the cascade, so it is stated here."""
    from_item_id: UUID
    to_item_id: UUID
    relation: EdgeRelation


class CascadePreview(BaseModel):
    """What deleting the root would actually do — computed, not asserted.

    `flag_for_review` is the honest half of SYSTEM_DESIGN §3 step 2: dependents
    with another independent source are *not* re-derived. They are tombstoned
    nowhere and marked for the user to look at. The UI must say that plainly
    rather than implying re-derivation happened (CLAUDE.md honesty constraints).
    """
    root_id: UUID
    cascade_delete: list[UUID]
    flag_for_review: list[UUID]
    relationship_affected: list[UUID]
    attribution_count: int


class ProvenanceGraph(BaseModel):
    root_id: UUID | None = None
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    cascade: CascadePreview | None = None
    # True when the graph was clipped by the node cap, so the UI can say it is
    # showing a subset instead of implying it is showing everything.
    truncated: bool = False


# ------------------------------------------------------------------ P1 turn

class TurnRequest(BaseModel):
    content: str = Field(min_length=1)
    # P3: excludes this turn from extraction entirely, not from the UI.
    session_ephemeral: bool = False

    # D32: which chat provider answers this turn. Absent means the server's
    # default; an unknown value falls back rather than failing the turn, and the
    # response reports which one actually ran.
    provider: str | None = None

    # Pin the turn to specific memories instead of retrieving. Both of these
    # were read by chats.chat_turn but never declared here, so every turn raised
    # AttributeError on TurnRequest and the conversation could not proceed —
    # which is why no review card or attribution chip ever rendered.
    selected_memory_ids: list[UUID] | None = None


class UsedMemory(BaseModel):
    """A memory item that was injected into the prompt for this response.

    Honest naming: at P1 this records what was *retrieved and injected*, which is not
    the same claim as what demonstrably *shaped* the wording. P6 narrows it.
    """
    id: UUID
    content: str
    status: AssertionStatus
    scope: Scope
    sensitivity: Sensitivity
    block_name: str | None
    distance: float
    # P6 decay: in_progress and unconfirmed past the threshold. Still usable, but never
    # asserted as current without a re-check.
    is_stale: bool = False


class RetrievalCandidate(BaseModel):
    """One memory the vector search ranked, and what happened to it."""

    id: UUID
    content: str
    block_name: str | None = None
    distance: float
    # injected | too_distant | private_block | revoked | pinned
    verdict: str


class RetrievalTrace(BaseModel):
    """How the memories for this turn were chosen.

    Exists so "retrieval is scoped and filtered" is checkable rather than asserted.
    The counts below distinguish outcomes that look identical in the result set and
    mean very different things: nothing matched, versus things matched and were not
    allowed through.
    """

    query: str
    considered: list[RetrievalCandidate] = []
    injected_count: int = 0
    # Blocked by a private block — the model's prompt did not contain these.
    withheld_private: int = 0
    dropped_too_distant: int = 0
    revoked_count: int = 0
    fenced_to_another_chat: int = 0
    awaiting_review: int = 0
    not_embedded: int = 0
    max_distance: float = 0.0
    embedding_failed: bool = False


class TurnResponse(BaseModel):
    user_message: Message
    assistant_message: Message
    used_memories: list[UsedMemory]
    # False when the turn was ephemeral, so the UI can say "nothing was extracted"
    # rather than spinning on an indicator that will never resolve.
    extraction_running: bool
    # Which provider/model actually answered. Reported rather than assumed, because
    # a stale or unconfigured selection falls back silently otherwise.
    provider: str | None = None
    model: str | None = None
    # The model's own <think> scratchpad, verbatim. Empty for models that emit none;
    # never synthesised, because reasoning the UI made up would be indistinguishable
    # from reasoning the model actually did.
    reasoning: str = ""
    # How the memories above were selected, including what was rejected and why.
    retrieval: RetrievalTrace | None = None


class CandidatesResponse(BaseModel):
    status: ExtractionStatus
    error: str | None = None
    candidates: list[MemoryItem]
    auto_accepted: list[MemoryItem]


# ------------------------------------------------------------------ P1 edits

# ------------------------------------------------------------------ P6

class RegenerateRequest(BaseModel):
    message_id: UUID
    revoke_item_ids: list[UUID] = Field(default_factory=list)
    # Same switchable-chat rule as a normal turn (D32). Regenerating on a different
    # model than answered originally is legitimate — the revoked memory is the
    # variable under test, and holding the model fixed is not required for that.
    provider: str | None = None


class RegenerateResponse(BaseModel):
    previous: str
    regenerated: str
    revoked: list[UsedMemory]
    used_memories: list[UsedMemory]
    assistant_message: Message


class DraftRequest(BaseModel):
    instruction: str = Field(min_length=1)
    # Deliberately no `provider`, unlike a chat turn (D32/D33). The draft's claim
    # decomposition is the input to the overstatement check, so which model produces
    # it must not be a dropdown — that would make the P6 guarantee non-reproducible.


class DraftClaim(BaseModel):
    """One assertion in a high-stakes draft, checked against its sources."""
    text: str
    asserted_as: AssertionStatus | None
    sources: list[UsedMemory]
    # True when the sentence claims more completeness than the memory supports —
    # the CV failure case, detected in Python rather than by asking the model.
    overstates: bool
    # True when a source is stale, even if the phrasing is accurate.
    stale_source: bool
    problem: str | None


class VerifiedDraft(BaseModel):
    instruction: str
    draft: str
    claims: list[DraftClaim]
    # True when at least one claim needs confirmation. The draft is still returned —
    # withholding it would just make the user re-ask — but it is not clean to ship.
    needs_confirmation: bool


class HiddenItem(BaseModel):
    """A memory that exists but is unreachable from the current chat."""
    id: UUID
    content: str
    block_name: str | None
    origin_chat_title: str | None


class ScopeReport(BaseModel):
    """What this session can and cannot see. Powers the P3 demo.

    The point of surfacing this is that "session-only" is otherwise an invisible
    claim — the user is asked to trust that something is confined. This makes the
    boundary countable, and `items_from_ephemeral_turns_global` makes it checkable.
    """
    chat_id: UUID
    visible_persistent: int
    visible_session: int
    hidden_session_items: list[HiddenItem]
    ephemeral_turns: int
    # Database-wide, not per chat. Structurally always 0: extraction returns before
    # calling the LLM when a turn is ephemeral, so no row can reference one. Reported
    # rather than asserted because a number a judge can watch beats a promise.
    items_from_ephemeral_turns_global: int


class MemoryItemEdit(BaseModel):
    """All fields optional — the review card edits one thing at a time."""
    content: str | None = None
    status: AssertionStatus | None = None
    sensitivity: Sensitivity | None = None
    block_name: str | None = None


class RescopeRequest(BaseModel):
    scope: Scope
