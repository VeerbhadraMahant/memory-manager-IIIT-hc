"""Which memories are allowed to shape this response.

Three filters, all load-bearing:

1. **Scope.** A session-scoped item is visible only inside the chat that produced it.
   Enforced in SQL, so a bug in the UI cannot leak it into another conversation.
2. **Review state.** Only items the user accepted — or that were auto-accepted under
   the interruption budget — are eligible. A candidate still awaiting review has not
   been agreed to yet, so it must not influence anything.
3. **Private blocks.** Items in a block the user marked private are excluded here,
   which is the only place that can be true: this function is what builds the prompt
   payload, so an item filtered out here is an item the model never receives.

Everything this function decides is also *reported*. `retrieve()` returns the rows it
selected plus a `RetrievalTrace` recording what it considered and why each candidate
was kept or dropped. The trace is the point rather than a debugging aid: the project
claims memory is negotiated and scoped, and a claim about retrieval is only checkable
if retrieval says what it did.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from app.config import settings
from app.services import llm

log = logging.getLogger(__name__)

# Cosine distance, not similarity: 0 is identical, 2 is opposite. Anything past this
# is unrelated enough that injecting it adds noise and dilutes attribution.
MAX_DISTANCE = 0.65
TOP_K = 8

# Ranked candidates, before the distance cut. Wider than TOP_K on purpose: the trace
# is more useful when it can show near-misses, and the extra rows are discarded
# rather than injected.
TRACE_K = 14

RETRIEVE_SQL = """
select mi.id, mi.content, mi.status, mi.scope, mi.sensitivity, mi.source_type,
       b.name as block_name,
       coalesce(b.private, false) as block_private,
       mi.embedding <=> %s::vector as distance,
       -- P6 decay: something the user was in the middle of months ago is not
       -- evidence that they still are. Only in_progress decays — a completed fact
       -- does not become less true with time.
       (mi.status = 'in_progress'
        and coalesce(mi.last_confirmed_at, mi.created_at)
            < now() - make_interval(days => %s)) as is_stale
from memory_items mi
left join blocks b on b.id = mi.block_id
where mi.user_id = %s
  and mi.deleted_at is null
  and mi.review_state in ('accepted', 'auto_accepted')
  and mi.embedding is not null
  and (mi.scope = 'persistent' or mi.session_chat_id = %s)
order by distance
limit %s
"""

# Counted separately so the trace can distinguish "nothing matched" from "things
# matched but were not allowed through". Those look identical in the result set and
# mean completely different things to someone judging whether scoping works.
EXCLUDED_SQL = """
select
  count(*) filter (
    where mi.scope = 'session' and mi.session_chat_id is distinct from %s
  ) as fenced_to_another_chat,
  count(*) filter (where mi.review_state = 'pending')   as awaiting_review,
  count(*) filter (where mi.embedding is null)          as not_embedded
from memory_items mi
where mi.user_id = %s and mi.deleted_at is null
"""


@dataclass
class Candidate:
    """One row the vector search ranked, and what happened to it."""

    id: str
    content: str
    block_name: str | None
    distance: float
    # injected | too_distant | private_block | revoked
    verdict: str


@dataclass
class RetrievalTrace:
    query: str
    considered: list[Candidate] = field(default_factory=list)
    injected_count: int = 0
    # Withheld because the block is private — the headline number for the privacy
    # claim, because it means the model's prompt did not contain these.
    withheld_private: int = 0
    dropped_too_distant: int = 0
    revoked_count: int = 0
    fenced_to_another_chat: int = 0
    awaiting_review: int = 0
    not_embedded: int = 0
    max_distance: float = MAX_DISTANCE
    embedding_failed: bool = False

    def as_dict(self) -> dict:
        return {
            "query": self.query,
            "considered": [c.__dict__ for c in self.considered],
            "injected_count": self.injected_count,
            "withheld_private": self.withheld_private,
            "dropped_too_distant": self.dropped_too_distant,
            "revoked_count": self.revoked_count,
            "fenced_to_another_chat": self.fenced_to_another_chat,
            "awaiting_review": self.awaiting_review,
            "not_embedded": self.not_embedded,
            "max_distance": self.max_distance,
            "embedding_failed": self.embedding_failed,
        }


def retrieve_traced(
    cur, user_id: str, chat_id: str, query: str, exclude: set[str] | None = None
) -> tuple[list[dict], RetrievalTrace]:
    """The rows to inject, plus the record of how they were chosen."""
    trace = RetrievalTrace(query=query)

    try:
        vec = llm.embed([query])[0]
    except Exception:
        # A failed embedding should cost the response its memory, not its existence.
        log.exception("embedding failed during retrieval; answering without memory")
        trace.embedding_failed = True
        return [], trace

    cur.execute(
        RETRIEVE_SQL, (str(vec), settings.stale_after_days, user_id, chat_id, TRACE_K)
    )
    ranked = cur.fetchall()

    kept: list[dict] = []
    for row in ranked:
        item_id = str(row["id"])
        if exclude and item_id in exclude:
            verdict = "revoked"
            trace.revoked_count += 1
        elif row["block_private"]:
            # Checked before distance so the trace attributes the withholding to the
            # privacy setting rather than to relevance — the user needs to know the
            # block did it, not that the item happened to be unrelated.
            verdict = "private_block"
            trace.withheld_private += 1
        elif row["distance"] > MAX_DISTANCE:
            verdict = "too_distant"
            trace.dropped_too_distant += 1
        elif len(kept) >= TOP_K:
            verdict = "too_distant"
            trace.dropped_too_distant += 1
        else:
            verdict = "injected"
            kept.append(row)

        trace.considered.append(
            Candidate(
                id=item_id,
                content=row["content"],
                block_name=row["block_name"],
                distance=round(float(row["distance"]), 4),
                verdict=verdict,
            )
        )

    trace.injected_count = len(kept)

    cur.execute(EXCLUDED_SQL, (chat_id, user_id))
    excluded = cur.fetchone()
    trace.fenced_to_another_chat = excluded["fenced_to_another_chat"]
    trace.awaiting_review = excluded["awaiting_review"]
    trace.not_embedded = excluded["not_embedded"]

    return kept, trace


def retrieve(
    cur, user_id: str, chat_id: str, query: str, exclude: set[str] | None = None
) -> list[dict]:
    """Rows only. Kept so callers that do not surface a trace stay unchanged."""
    rows, _ = retrieve_traced(cur, user_id, chat_id, query, exclude)
    return rows


def pinned_trace(query: str, rows: list[dict]) -> RetrievalTrace:
    """A trace for the path where the caller pinned specific memories.

    No search ran, so there is nothing to rank and no distances to report. Saying so
    explicitly beats returning an empty trace, which the UI would render as "nothing
    was retrieved" — the opposite of what happened.
    """
    trace = RetrievalTrace(query=query, injected_count=len(rows))
    trace.considered = [
        Candidate(
            id=str(r["id"]),
            content=r["content"],
            block_name=r.get("block_name"),
            distance=0.0,
            verdict="pinned",
        )
        for r in rows
    ]
    return trace
