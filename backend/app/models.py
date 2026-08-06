"""Pydantic mirrors of the DB vocabulary.

These enum values must match migrations/001_init.sql exactly. They are the shared
vocabulary from CLAUDE.md — the same words appear in the schema, the API, and the UI
labels, so a rename is a three-file change on purpose rather than a silent drift.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


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


class Chat(BaseModel):
    id: UUID
    user_id: UUID
    title: str | None
    created_at: datetime


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


# ------------------------------------------------------------------ P1 turn

class TurnRequest(BaseModel):
    content: str = Field(min_length=1)
    # P3: excludes this turn from extraction entirely, not from the UI.
    session_ephemeral: bool = False


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


class TurnResponse(BaseModel):
    user_message: Message
    assistant_message: Message
    used_memories: list[UsedMemory]
    # False when the turn was ephemeral, so the UI can say "nothing was extracted"
    # rather than spinning on an indicator that will never resolve.
    extraction_running: bool


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


class RegenerateResponse(BaseModel):
    previous: str
    regenerated: str
    revoked: list[UsedMemory]
    used_memories: list[UsedMemory]
    assistant_message: Message


class DraftRequest(BaseModel):
    instruction: str = Field(min_length=1)


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
    # calling Gemini when a turn is ephemeral, so no row can reference one. Reported
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
