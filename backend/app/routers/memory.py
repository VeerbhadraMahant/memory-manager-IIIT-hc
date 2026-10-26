from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import User, current_user
from app.config import settings
from app.db import db_cursor, pool
from app.models import (
    AssertionStatus,
    Block,
    BlockFlows,
    BlockPrivacy,
    CascadePreview,
    DigestEntry,
    DigestResponse,
    EdgeDecision,
    EdgeProposal,
    EdgeState,
    GraphEdge,
    MemoryItem,
    MemoryItemCreate,
    MemoryItemEdit,
    NodeSummary,
    ProvenanceGraph,
    PruneResponse,
    RelevanceRequest,
    RelevanceResponse,
    RescopeRequest,
    ReviewState,
    Scope,
    Sensitivity,
    Subnode,
    SubnodeCreate,
    SubnodeEdit,
)
from app.ratelimit import general_limit, llm_limit, spend_llm
from app.services import llm
from app.services.policy import THIRD_PARTY_REASON
from app.services.retrieval import MAX_DISTANCE, embed_query

log = logging.getLogger(__name__)

router = APIRouter(prefix="/memory", tags=["memory"], dependencies=[Depends(general_limit)])


# Joined so the API never makes the client resolve a block id to a human label.
ITEM_SELECT = """
select mi.*, b.name as block_name
from memory_items mi
left join blocks b on b.id = mi.block_id
"""


# denied_destinations is cast to text[]: psycopg returns an unregistered enum array as a
# raw '{draft}' string (migration 009).
BLOCK_COLS = """id, name, default_sensitivity, restrictive_rank, is_fallback,
               coalesce(private, false) as private,
               denied_destinations::text[] as denied_destinations"""


@router.get("/blocks", response_model=list[Block])
def list_blocks(user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    cur.execute(
        f"""
        select {BLOCK_COLS}
        from blocks where user_id = %s
        order by restrictive_rank
        """,
        (user.id,),
    )
    return cur.fetchall()


@router.patch("/blocks/{name}/privacy", response_model=Block)
def set_block_privacy(name: str, payload: BlockPrivacy, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Mark a block private, or lift it.

    Private means retrieval excludes the block, so its memories are never written into
    a prompt (services/retrieval.py). It does not hide them from the user, and it does
    not delete anything — the items stay listed, editable and deletable, they simply
    stop being available to the model.

    The fallback block is refused. It is where low-confidence items land by design
    (D3), so making it private would silently withhold everything the classifier was
    unsure about — a privacy setting that quietly degrades the assistant is worse than
    one the user chose per block.
    """
    cur.execute(
        "select is_fallback from blocks where user_id = %s and name = %s",
        (user.id, name),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"unknown block: {name}")
    if row["is_fallback"] and payload.private:
        raise HTTPException(
            422,
            "the fallback block cannot be private — unclassified items would be "
            "withheld without you having chosen that",
        )

    cur.execute(
        f"""update blocks set private = %s
            where user_id = %s and name = %s
        returning {BLOCK_COLS}""",
        (payload.private, user.id, name),
    )
    updated = cur.fetchone()
    cur.connection.commit()
    return updated


def dedupe_destinations(destinations) -> list[str]:
    """Deny-list as plain strings, duplicates dropped, first-seen order kept."""
    return list(dict.fromkeys(d.value for d in destinations))


@router.patch("/blocks/{name}/flows", response_model=Block)
def set_block_flows(name: str, payload: BlockFlows, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Replace the places this block's memories may not flow to (chat, draft, summary,
    relevance). It replaces the whole list, so an empty list lifts every restriction.

    Independent of `private`, which still wins: a private block reaches none of them.
    """
    cur.execute(
        f"""update blocks set denied_destinations = %s::text[]::flow_destination[]
            where user_id = %s and name = %s
        returning {BLOCK_COLS}""",
        (dedupe_destinations(payload.denied_destinations), user.id, name),
    )
    updated = cur.fetchone()
    if not updated:
        raise HTTPException(404, f"unknown block: {name}")
    cur.connection.commit()
    return updated


@router.get("/items", response_model=list[MemoryItem])
def list_items(
    user: User = Depends(current_user), cur=Depends(db_cursor, scope="function"),
    block: str | None = None,
    status: AssertionStatus | None = None,
    sensitivity: Sensitivity | None = None,
    scope: Scope | None = None,
    review_state: ReviewState | None = None,
    q: str | None = Query(None, description="substring match on content"),
    include_deleted: bool = False,
    limit: int = Query(200, ge=1, le=1000),
):
    """Backs the P4 list view. Filters compose; all are optional."""
    where = ["mi.user_id = %s"]
    params: list = [user.id]

    # Tombstoned items are invisible unless explicitly asked for (cascade policy §3).
    if not include_deleted:
        where.append("mi.deleted_at is null")
    if block:
        where.append("b.name = %s")
        params.append(block)
    if status:
        where.append("mi.status = %s")
        params.append(status.value)
    if sensitivity:
        where.append("mi.sensitivity = %s")
        params.append(sensitivity.value)
    if scope:
        where.append("mi.scope = %s")
        params.append(scope.value)
    if review_state:
        where.append("mi.review_state = %s")
        params.append(review_state.value)
    if q:
        where.append("mi.content ilike %s")
        params.append(f"%{q}%")

    params.append(limit)
    cur.execute(
        f"{ITEM_SELECT} where {' and '.join(where)} order by mi.created_at desc limit %s",
        params,
    )
    return cur.fetchall()


@router.get("/items/{item_id}", response_model=MemoryItem)
def get_item(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    cur.execute(f"{ITEM_SELECT} where mi.id = %s and mi.user_id = %s",
                (item_id, user.id))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "memory item not found")
    return row


@router.post("/items", response_model=MemoryItem, status_code=201, dependencies=[Depends(llm_limit)])
def create_item(payload: MemoryItemCreate, user: User = Depends(current_user)):
    """Direct insert. P1 replaces this as the *primary* path with extraction-driven
    candidate creation; it stays for tests and manual entry."""

    # Checked here for a clean 422, and again by the schema CHECK constraint.
    if payload.scope is Scope.session and payload.session_chat_id is None:
        raise HTTPException(422, "session-scoped items require session_chat_id")
    if payload.scope is Scope.persistent and payload.session_chat_id is not None:
        raise HTTPException(422, "persistent items must not carry session_chat_id")

    # Embed on create, before taking a connection. Without this the item exists but is
    # invisible to retrieval, which is a confusing half-state: it shows in the list and
    # never influences a response.
    try:
        vec = str(llm.embed([payload.content])[0])
    except Exception as e:
        log.exception("embedding failed on create")
        raise HTTPException(502, f"could not embed content: {llm.public_error(e)}") from e

    with pool.connection() as conn, conn.cursor() as cur:
        # Both references must belong to the caller. The schema's foreign keys only
        # prove the rows exist, not whose they are — without this a user could attach
        # a memory to another user's message or chat.
        cur.execute(
            """select m.chat_id from messages m join chats c on c.id = m.chat_id
                where m.id = %s and c.user_id = %s""",
            (payload.source_message_id, user.id),
        )
        source = cur.fetchone()
        if not source:
            raise HTTPException(422, "source_message_id does not refer to one of your messages")
        if payload.session_chat_id is not None:
            cur.execute(
                "select 1 from chats where id = %s and user_id = %s and deleted_at is null",
                (payload.session_chat_id, user.id),
            )
            if not cur.fetchone():
                raise HTTPException(422, "session_chat_id does not refer to one of your chats")

        # Unknown or unnamed block -> the fallback block, which is the *most* restrictive
        # one, not a neutral bucket (D3).
        if payload.block_name:
            cur.execute("select id from blocks where user_id = %s and name = %s",
                        (user.id, payload.block_name))
            row = cur.fetchone()
            if not row:
                raise HTTPException(422, f"unknown block: {payload.block_name}")
            block_id = row["id"]
        else:
            cur.execute("select id from blocks where user_id = %s and is_fallback", (user.id,))
            block_id = cur.fetchone()["id"]

        scope, session_chat_id = payload.scope, payload.session_chat_id
        review_state, needs_review, reason = payload.review_state, payload.needs_review, None
        if payload.status is AssertionStatus.third_party:
            # Same rule as extraction's policy.decide (F8): a fact about someone else
            # stays in the chat it came from and gets a review, however it was entered.
            scope, session_chat_id = Scope.session, source["chat_id"]
            review_state, needs_review, reason = ReviewState.pending, True, THIRD_PARTY_REASON

        cur.execute(
            """
            insert into memory_items (
                user_id, block_id, content, source_type, status, sensitivity, scope,
                confidence, source_message_id, session_chat_id, review_state, needs_review,
                review_reason, embedding, content_origin
            ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'user_written')
            returning id
            """,
            (
                user.id, block_id, payload.content,
                payload.source_type.value, payload.status.value,
                payload.sensitivity.value, scope.value, payload.confidence,
                payload.source_message_id, session_chat_id,
                review_state.value, needs_review, reason, vec,
            ),
        )
        new_id = cur.fetchone()["id"]

        cur.execute(
            "insert into audit_log (memory_item_id, action, actor, detail) values (%s,%s,%s,%s)",
            (new_id, "created", "system", '{"via": "POST /memory/items"}'),
        )
        cur.execute(f"{ITEM_SELECT} where mi.id = %s", (new_id,))
        return cur.fetchone()


# --------------------------------------------------------------------------
# Negotiation (P1). Every one of these is reachable from the review card inline in
# the conversation — memory formation is an in-conversation event, not a settings
# page (D1). They are also plain REST, so P4's list view reuses them unchanged.
# --------------------------------------------------------------------------

def _load(cur, item_id: UUID, user_id: UUID) -> dict:
    cur.execute(
        "select * from memory_items where id = %s and user_id = %s and deleted_at is null",
        (item_id, user_id),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "memory item not found")
    return row


def _audit(cur, item_id: UUID, action: str, detail: dict | None = None) -> None:
    cur.execute(
        "insert into audit_log (memory_item_id, action, actor, detail) values (%s,%s,'user',%s)",
        (item_id, action, json.dumps(detail or {})),
    )


def _return(cur, item_id: UUID):
    cur.execute(f"{ITEM_SELECT} where mi.id = %s", (item_id,))
    return cur.fetchone()


@router.post("/items/{item_id}/accept", response_model=MemoryItem)
def accept_item(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    _load(cur, item_id, user.id)
    cur.execute(
        """update memory_items
           set review_state = 'accepted', needs_review = false, last_confirmed_at = now()
           where id = %s""",
        (item_id,),
    )
    _audit(cur, item_id, "accepted")
    cur.connection.commit()
    return _return(cur, item_id)


@router.post("/items/{item_id}/reject", response_model=MemoryItem)
def reject_item(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Rejection tombstones rather than deletes.

    The audit trail is the point: "the system proposed this and the user said no" is
    a different and more useful record than the row never having existed. Rejected
    items are excluded from retrieval by review_state, so this costs nothing at
    use time.
    """
    _load(cur, item_id, user.id)
    cur.execute(
        "update memory_items set review_state = 'rejected', deleted_at = now() where id = %s",
        (item_id,),
    )
    _audit(cur, item_id, "rejected")
    cur.connection.commit()
    cur.execute(f"{ITEM_SELECT} where mi.id = %s", (item_id,))
    return cur.fetchone()


@router.patch("/items/{item_id}", response_model=MemoryItem)
def edit_item(item_id: UUID, payload: MemoryItemEdit, user: User = Depends(current_user)):
    """Correct the item in place.

    A correction is an acceptance: the user has looked at it and said what it should
    say, so there is no reason to make them press accept afterwards. Editing the
    content re-embeds, or retrieval would keep matching the wording the user rejected.
    """
    vec: str | None = None
    if payload.content is not None:
        with pool.connection() as conn, conn.cursor() as cur:
            before = _load(cur, item_id, user.id)
        if payload.content != before["content"]:
            spend_llm(user)
            try:
                vec = str(llm.embed([payload.content])[0])
            except Exception as e:
                log.exception("re-embedding failed on edit")
                raise HTTPException(502, f"could not re-embed edited content: {llm.public_error(e)}") from e

    with pool.connection() as conn, conn.cursor() as cur:
        before = _load(cur, item_id, user.id)

        sets: list[str] = []
        params: list = []
        changed: dict = {}

        if payload.content is not None and payload.content != before["content"]:
            sets += ["content = %s", "embedding = %s", "content_origin = 'user_edited'"]
            params += [payload.content, vec]
            changed["content"] = {"from": before["content"], "to": payload.content}

        for field in ("status", "sensitivity"):
            val = getattr(payload, field)
            if val is not None and val.value != before[field]:
                sets.append(f"{field} = %s")
                params.append(val.value)
                changed[field] = {"from": before[field], "to": val.value}

        if payload.block_name is not None:
            cur.execute(
                "select id, name from blocks where user_id = %s and name = %s",
                (user.id, payload.block_name),
            )
            blk = cur.fetchone()
            if not blk:
                raise HTTPException(422, f"unknown block: {payload.block_name}")
            if blk["id"] != before["block_id"]:
                sets.append("block_id = %s")
                params.append(blk["id"])
                changed["block"] = payload.block_name

        if not sets:
            return _return(cur, item_id)

        sets += ["review_state = 'accepted'", "needs_review = false", "last_confirmed_at = now()"]
        params.append(item_id)
        cur.execute(f"update memory_items set {', '.join(sets)} where id = %s", params)
        _audit(cur, item_id, "edited", changed)
        return _return(cur, item_id)


@router.post("/items/{item_id}/rescope", response_model=MemoryItem)
def rescope_item(item_id: UUID, payload: RescopeRequest, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Move an item between session and persistent.

    Demoting to session needs a chat to anchor to (D14); the source message's chat is
    the only defensible choice, since that is the conversation the fact was disclosed in.
    """
    before = _load(cur, item_id, user.id)
    if before["scope"] == payload.scope.value:
        return _return(cur, item_id)

    if payload.scope is Scope.session:
        cur.execute("select chat_id from messages where id = %s", (before["source_message_id"],))
        chat_id = cur.fetchone()["chat_id"]
    else:
        chat_id = None

    cur.execute(
        "update memory_items set scope = %s, session_chat_id = %s where id = %s",
        (payload.scope.value, chat_id, item_id),
    )
    _audit(cur, item_id, "rescoped", {"from": before["scope"], "to": payload.scope.value})
    cur.connection.commit()
    return _return(cur, item_id)


# --------------------------------------------------------------------------
# Decay and provenance. Every route from SYSTEM_DESIGN §3 is now built; nothing
# in this module answers 501 any more.
# --------------------------------------------------------------------------

@router.post("/items/{item_id}/confirm", response_model=MemoryItem)
def confirm_item(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """"Yes, this is still true." Resets the decay clock.

    Decay is not deletion — a stale item is still used, just never asserted as current
    without a re-check. Confirming is the cheapest possible correction, which is the
    point: the alternative to a one-tap confirm is silent reuse of a fact that has
    quietly stopped being true (D4).
    """
    _load(cur, item_id, user.id)
    cur.execute(
        "update memory_items set last_confirmed_at = now(), needs_review = false where id = %s",
        (item_id,),
    )
    _audit(cur, item_id, "confirmed")
    cur.connection.commit()
    return _return(cur, item_id)


# --------------------------------------------------------------------------
# P5 provenance graph + cascade delete.
#
# Scope is deliberately narrow (PHASES.md P5): this is not a general graph
# browser. Its job is "if I delete this, what dies and what degrades", and the
# same answer has to be available as text — the graph is supplementary, the
# textual equivalent is lossless (CLAUDE.md principle 6).
# --------------------------------------------------------------------------

# Above this the graph stops being readable and starts being a hairball
# (frontend_design_guideline §3.4). The cap lives here rather than only in the
# client so the wire payload is bounded too.
GRAPH_NODE_CAP = 150

GRAPH_SELECT = """
select mi.id, mi.content, mi.source_type, mi.status, mi.sensitivity, mi.scope,
       b.name as block_name, mi.review_state, mi.needs_review, mi.confidence,
       mi.last_confirmed_at, mi.deleted_at, mi.content_origin
from memory_items mi
left join blocks b on b.id = mi.block_id
"""

# Only these two relations carry derivation, so only these two cascade.
# `contradicts` and `updates` describe how two independent facts relate; deleting
# one end invalidates the *relationship claim*, not the other fact.
DERIVING = ("derived_from", "summarized_from")

# Proposed edges are drawn (the UI marks them as proposed); rejected ones never are.
EDGE_SELECT = """select id, from_item_id, to_item_id, relation, state, origin from memory_edges
   where from_item_id = any(%s) and to_item_id = any(%s) and state <> 'rejected'"""


def _cascade(cur, root_id: UUID) -> tuple[CascadePreview, set[UUID]]:
    """Walk the derivation edges out of `root_id` and classify what it reaches.

    Returns the preview and the full set of item ids touched, so the caller can
    render exactly the subgraph the preview describes rather than a different one.
    """
    # Pass 1: everything reachable along derivation edges. BFS, not recursion: a
    # `derived_from` chain is user-generated data and a cycle would be a stack
    # overflow rather than a bug report. `order` keeps the result deterministic.
    order: list[UUID] = []
    seen: set[UUID] = {root_id}
    frontier = [root_id]
    while frontier:
        current = frontier.pop(0)
        cur.execute(
            """select e.to_item_id
               from memory_edges e
               join memory_items mi on mi.id = e.to_item_id
               where e.from_item_id = %s and e.relation = any(%s)
                 and e.state = 'confirmed' and mi.deleted_at is null
               order by mi.created_at, mi.id""",
            (current, list(DERIVING)),
        )
        for row in cur.fetchall():
            dependent = row["to_item_id"]
            if dependent not in seen:
                seen.add(dependent)
                order.append(dependent)
                frontier.append(dependent)

    # Every live item each reachable dependent was derived from.
    parents: dict[UUID, set[UUID]] = {d: set() for d in order}
    if order:
        cur.execute(
            """select e.to_item_id, e.from_item_id
               from memory_edges e
               join memory_items mi on mi.id = e.from_item_id
               where e.to_item_id = any(%s) and e.relation = any(%s)
                 and e.state = 'confirmed' and mi.deleted_at is null""",
            (order, list(DERIVING)),
        )
        for row in cur.fetchall():
            parents[row["to_item_id"]].add(row["from_item_id"])

    # Pass 2: an item goes only when *everything* it was derived from goes. Iterated
    # to a fixpoint rather than decided once per item during the walk: deciding in
    # walk order counted a sibling as surviving support before the walk had reached
    # it, and counted an item already flagged-but-surviving as gone, so the verdict
    # depended on traversal order. A cycle that supports itself is kept and flagged —
    # deletion is the irreversible direction, so ambiguity resolves away from it.
    deleting: set[UUID] = {root_id}
    changed = True
    while changed:
        changed = False
        for d in order:
            if d not in deleting and parents[d] <= deleting:
                deleting.add(d)
                changed = True

    cascade_delete = [d for d in order if d in deleting]
    # Survives, but on a thinner evidence base than it was written on. Not
    # re-derived — flagged, and the UI says so (SYSTEM_DESIGN §3 step 2).
    flag_for_review = [d for d in order if d not in deleting and parents[d] & deleting]
    touched: set[UUID] = {root_id, *cascade_delete, *flag_for_review}

    # Relationship edges in either direction: the other end is still true, but the
    # statement "these two disagree" / "this supersedes that" loses one of its ends.
    cur.execute(
        """select distinct case when e.from_item_id = %s then e.to_item_id
                                else e.from_item_id end as other_id
           from memory_edges e
           join memory_items mi
             on mi.id = case when e.from_item_id = %s then e.to_item_id else e.from_item_id end
           where (e.from_item_id = %s or e.to_item_id = %s)
             and e.relation in ('contradicts', 'updates') and e.state = 'confirmed'
             and mi.deleted_at is null""",
        (root_id, root_id, root_id, root_id),
    )
    relationship_affected = [r["other_id"] for r in cur.fetchall()]
    touched.update(relationship_affected)

    # Past answers that used any of this. Deleting does not rewrite history, and
    # the count is shown so nobody assumes it does.
    ids = list(touched)
    cur.execute(
        "select count(distinct message_id) as n from attributions where memory_item_id = any(%s)",
        (ids,),
    )
    attribution_count = cur.fetchone()["n"]

    return (
        CascadePreview(
            root_id=root_id,
            cascade_delete=cascade_delete,
            flag_for_review=flag_for_review,
            relationship_affected=relationship_affected,
            attribution_count=attribution_count,
        ),
        touched,
    )


@router.get("/graph", response_model=ProvenanceGraph)
def full_graph(user: User = Depends(current_user), cur=Depends(db_cursor, scope="function"), limit: int = Query(GRAPH_NODE_CAP, ge=1, le=500)):
    """Every live item and every edge between them — the graph view's backing data.

    Capped, and it reports when it capped. A view that silently shows 150 of 400
    memories is a worse lie than one that refuses to draw.
    """
    cur.execute(
        f"{GRAPH_SELECT} where mi.user_id = %s and mi.deleted_at is null "
        f"and mi.review_state <> 'rejected' order by mi.created_at desc limit %s",
        (user.id, limit + 1),
    )
    rows = cur.fetchall()
    truncated = len(rows) > limit
    rows = rows[:limit]

    ids = [r["id"] for r in rows]
    edges = []
    if ids:
        cur.execute(
            EDGE_SELECT,
            (ids, ids),
        )
        edges = cur.fetchall()

    return ProvenanceGraph(nodes=rows, edges=edges, truncated=truncated)


@router.get("/items/{item_id}/graph", response_model=ProvenanceGraph)
def item_graph(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """The deletion preview, as data. Answers exactly one question."""
    _load(cur, item_id, user.id)
    cascade, touched = _cascade(cur, item_id)

    ids = list(touched)
    cur.execute(f"{GRAPH_SELECT} where mi.id = any(%s)", (ids,))
    nodes = cur.fetchall()

    cur.execute(
        EDGE_SELECT,
        (ids, ids),
    )
    return ProvenanceGraph(
        root_id=item_id, nodes=nodes, edges=cur.fetchall(), cascade=cascade
    )


@router.delete("/items/{item_id}", response_model=CascadePreview)
def delete_item(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Tombstone an item and everything that exists only because of it.

    Executes exactly the preview `GET /items/{id}/graph` showed — same `_cascade`
    walk — so what the user was told and what happened cannot diverge.

    * the root and every dependent with no other support are tombstoned;
    * dependents that still have independent support survive, flagged for review —
      they are NOT re-derived, and the UI says so;
    * the far end of a `contradicts` / `updates` edge is true independently, so it is
      kept and flagged, because the statement about the pair lost one side;
    * past assistant messages are not rewritten. `attribution_count` says how many
      used these memories, so nobody assumes deleting rewrites history.
    """
    root = _load(cur, item_id, user.id)
    cascade, _ = _cascade(cur, item_id)

    doomed = [item_id, *cascade.cascade_delete]
    cur.execute(
        "update memory_items set deleted_at = now() where id = any(%s) and user_id = %s and deleted_at is null",
        (doomed, user.id),
    )
    _audit(cur, item_id, "deleted", {"cascade_delete": [str(i) for i in cascade.cascade_delete]})
    for dep in cascade.cascade_delete:
        _audit(cur, dep, "deleted_by_cascade", {"root": str(item_id)})

    reason = f"a memory this relied on was deleted: {root['content'][:120]}"
    flagged = [*cascade.flag_for_review, *cascade.relationship_affected]
    if flagged:
        cur.execute(
            "update memory_items set needs_review = true, review_reason = %s where id = any(%s) and user_id = %s",
            (reason, flagged, user.id),
        )
        for f in flagged:
            _audit(cur, f, "flagged_for_review", {"because_deleted": str(item_id)})
    return cascade


# --------------------------------------------------------------------------
# Subnodes: the child notes a user hangs off a memory in the graph view.
# --------------------------------------------------------------------------

MAX_SUBNODES_PER_ITEM = 200
PRUNE_BELOW_CONFIDENCE = 0.5

SUBNODE_COLS = "id, memory_item_id, content, confidence, category, created_at"


@router.get("/items/{item_id}/subnodes", response_model=list[Subnode])
def list_subnodes(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    _load(cur, item_id, user.id)
    cur.execute(
        f"select {SUBNODE_COLS} from memory_subnodes where memory_item_id = %s and user_id = %s order by created_at",
        (item_id, user.id),
    )
    return cur.fetchall()


@router.post("/items/{item_id}/subnodes", response_model=Subnode, status_code=201)
def create_subnode(
    item_id: UUID, payload: SubnodeCreate,
    user: User = Depends(current_user), cur=Depends(db_cursor, scope="function"),
):
    _load(cur, item_id, user.id)
    cur.execute("select count(*) as n from memory_subnodes where memory_item_id = %s", (item_id,))
    if cur.fetchone()["n"] >= MAX_SUBNODES_PER_ITEM:
        raise HTTPException(422, f"a memory can hold at most {MAX_SUBNODES_PER_ITEM} child notes")
    cur.execute(
        f"""insert into memory_subnodes (memory_item_id, user_id, content, confidence, category)
            values (%s, %s, %s, %s, %s) returning {SUBNODE_COLS}""",
        (item_id, user.id, payload.content, payload.confidence, payload.category),
    )
    row = cur.fetchone()
    _audit(cur, item_id, "subnode_added", {"subnode_id": str(row["id"])})
    return row


@router.patch("/subnodes/{subnode_id}", response_model=Subnode)
def edit_subnode(
    subnode_id: UUID, payload: SubnodeEdit,
    user: User = Depends(current_user), cur=Depends(db_cursor, scope="function"),
):
    fields = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not fields:
        cur.execute(
            f"select {SUBNODE_COLS} from memory_subnodes where id = %s and user_id = %s",
            (subnode_id, user.id),
        )
    else:
        sets = ", ".join(f"{k} = %s" for k in fields)  # keys come from the model, not the client
        cur.execute(
            f"""update memory_subnodes set {sets}, updated_at = now()
                where id = %s and user_id = %s returning {SUBNODE_COLS}""",
            (*fields.values(), subnode_id, user.id),
        )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "subnode not found")
    return row


@router.delete("/subnodes/{subnode_id}")
def delete_subnode(subnode_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    cur.execute(
        "delete from memory_subnodes where id = %s and user_id = %s returning memory_item_id",
        (subnode_id, user.id),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "subnode not found")
    _audit(cur, row["memory_item_id"], "subnode_deleted", {"subnode_id": str(subnode_id)})
    return {"status": "deleted", "id": str(subnode_id)}


@router.post("/items/{item_id}/prune", response_model=PruneResponse)
def prune_subnodes(item_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Drop child notes that are low-confidence or duplicates of an earlier one.

    Deterministic and explainable on purpose — no model decides what the user's notes
    were worth. Confidence below `PRUNE_BELOW_CONFIDENCE` goes; of notes with identical
    text (case/whitespace-insensitive) the earliest stays.
    """
    _load(cur, item_id, user.id)
    cur.execute(
        """delete from memory_subnodes s
            where s.memory_item_id = %s and s.user_id = %s
              and (s.confidence < %s
                   or exists (select 1 from memory_subnodes o
                               where o.memory_item_id = s.memory_item_id
                                 and lower(btrim(o.content)) = lower(btrim(s.content))
                                 and (o.created_at, o.id) < (s.created_at, s.id)))
        returning s.id""",
        (item_id, user.id, PRUNE_BELOW_CONFIDENCE),
    )
    n = len(cur.fetchall())
    if n:
        _audit(cur, item_id, "subnodes_pruned", {"count": n})
    return PruneResponse(
        pruned_count=n,
        message=f"Removed {n} child note{'s' if n != 1 else ''}." if n else "Nothing to prune.",
    )


def _fallback_summary(item: dict, notes: list[str]) -> tuple[str, str, list[str]]:
    title = item["content"].strip().split("\n")[0][:60]
    summary = f"{item['content'].strip()} (status: {item['status'].replace('_', ' ')})"
    return title, summary, notes[:5]


@router.get("/items/{item_id}/summary", response_model=NodeSummary)
def node_summary(item_id: UUID, user: User = Depends(current_user)):
    """Hover-card summary of a memory and its child notes.

    Uses the model when it can and a plain restatement when it cannot, so an LLM outage
    degrades the card rather than breaking it. A memory in a **private block is never
    sent to a model** — the same rule retrieval enforces — so it always gets the
    deterministic summary.
    """
    with pool.connection() as conn, conn.cursor() as cur:
        item = _load(cur, item_id, user.id)
        cur.execute(
            """select coalesce(private, false) as private,
                      'summary' = any(denied_destinations::text[]) as no_summary
                 from blocks where id = %s""",
            (item["block_id"],),
        )
        blk = cur.fetchone()
        if blk and blk["no_summary"]:
            raise HTTPException(
                409,
                "This block is set to keep its memories out of summaries, so no summary "
                "is written for this one. Allow summaries for the block to get one.",
            )
        private = bool(blk and blk["private"])
        cur.execute(
            "select content from memory_subnodes where memory_item_id = %s and user_id = %s order by created_at",
            (item_id, user.id),
        )
        notes = [r["content"] for r in cur.fetchall()]

    title, summary, points = _fallback_summary(item, notes)
    if not private:
        spend_llm(user)
        try:
            result = llm.summarize_item(item["content"], item["status"], notes)
            if result:
                title, summary, points = result.title, result.summary, result.key_points
        except Exception:
            log.exception("node summary failed; serving the deterministic summary")
    return NodeSummary(
        memory_item_id=item_id, title=title, summary=summary,
        key_points=points, subnode_count=len(notes),
    )


@router.post("/relevance", response_model=RelevanceResponse, dependencies=[Depends(llm_limit)])
def relevance(payload: RelevanceRequest, user: User = Depends(current_user)):
    """Per-memory relevance to a prompt, for the graph's retrieval highlight.

    Mirrors what retrieval would consider: persistent, accepted, live, and not in a
    private block. Highlighting a private memory as "would be used" would be a false
    claim about what the model can see. A block that denies `relevance` gets no score.
    """
    vec = embed_query(payload.prompt)
    if vec is None:
        raise HTTPException(502, "could not embed the prompt")
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """select mi.id, mi.embedding <=> %s::vector as distance
                 from memory_items mi
                 left join blocks b on b.id = mi.block_id
                where mi.user_id = %s and mi.deleted_at is null
                  and mi.review_state in ('accepted', 'auto_accepted')
                  and mi.scope = 'persistent'
                  and mi.embedding is not null
                  and not coalesce(b.private, false)
                  and not coalesce('relevance' = any(b.denied_destinations::text[]), false)""",
            (str(vec), user.id),
        )
        rows = cur.fetchall()
    scores = {
        str(r["id"]): round(1.0 - float(r["distance"]) / MAX_DISTANCE, 3)
        for r in rows
        if float(r["distance"]) < MAX_DISTANCE
    }
    return RelevanceResponse(scores=scores)


# --------------------------------------------------------------------------
# F4: proposed provenance edges. A heuristic guess does not count (cascade, retrieval)
# until the user confirms it.
# --------------------------------------------------------------------------

@router.get("/edges", response_model=list[EdgeProposal])
def list_edges(
    state: EdgeState = EdgeState.proposed,
    user: User = Depends(current_user), cur=Depends(db_cursor, scope="function"),
):
    """Edges in `state` (default proposed), newest first. Only edges whose two ends are
    both the caller's live items, so a proposal never mentions a deleted memory."""
    cur.execute(
        """select e.id, e.from_item_id, e.to_item_id,
                  f.content as from_content, t.content as to_content,
                  e.relation, e.origin, e.created_at
             from memory_edges e
             join memory_items f on f.id = e.from_item_id
             join memory_items t on t.id = e.to_item_id
            where e.state = %s and f.user_id = %s and t.user_id = %s
              and f.deleted_at is null and t.deleted_at is null
            order by e.created_at desc, e.id""",
        (state.value, user.id, user.id),
    )
    return cur.fetchall()


@router.patch("/edges/{edge_id}", response_model=GraphEdge)
def decide_edge(edge_id: UUID, payload: EdgeDecision, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Confirm or reject a proposed edge. Only a proposed edge can be decided: a
    decision is not silently overwritten by a second one."""
    cur.execute(
        """select e.state, f.deleted_at is not null or t.deleted_at is not null as end_deleted
             from memory_edges e
             join memory_items f on f.id = e.from_item_id
             join memory_items t on t.id = e.to_item_id
            where e.id = %s and f.user_id = %s and t.user_id = %s""",
        (edge_id, user.id, user.id),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "edge not found")
    # list_edges never shows these; a stale client must not confirm a link to a deleted memory.
    if row["end_deleted"]:
        raise HTTPException(409, "one of these memories was deleted, so this link cannot be decided")
    cur.execute(
        """update memory_edges set state = %s
            where id = %s and state = 'proposed'
        returning id, from_item_id, to_item_id, relation, state, origin""",
        (payload.state, edge_id),
    )
    edge = cur.fetchone()
    if not edge:
        raise HTTPException(409, f"this link was already {row['state']}, so it cannot be decided again")
    # Both ends: the decision changes how each of them is retrieved and cascaded.
    for item_id, other in ((edge["from_item_id"], "to_item_id"), (edge["to_item_id"], "from_item_id")):
        _audit(cur, item_id, f"edge_{payload.state}",
               {"edge_id": str(edge_id), other: str(edge[other]), "relation": edge["relation"]})
    cur.connection.commit()
    return edge


# --------------------------------------------------------------------------
# F12: what changed since the user last looked. Pure SQL, no model.
# --------------------------------------------------------------------------

DIGEST_LIMIT = 200

# Events: creation (extraction or the user), the audit actions worth reporting, and
# in_progress items that went stale in the window (same rule as retrieval's is_stale).
# Named parameters: user, since, days.
DIGEST_EVENTS = """
with ev as (
  select mi.id as memory_item_id, mi.created_at as at, 'created' as change
    from memory_items mi
   where mi.user_id = %(user)s and mi.created_at >= %(since)s
  union all
  select a.memory_item_id, a.created_at,
         case a.action when 'deleted_by_cascade' then 'deleted' else a.action end
    from audit_log a
    join memory_items mi on mi.id = a.memory_item_id
   where mi.user_id = %(user)s and a.created_at >= %(since)s
     and a.action in ('auto_accepted', 'edited', 'flagged_for_review', 'deleted', 'deleted_by_cascade')
  union all
  select mi.id, coalesce(mi.last_confirmed_at, mi.created_at) + make_interval(days => %(days)s), 'stale'
    from memory_items mi
   where mi.user_id = %(user)s and mi.deleted_at is null
     and mi.review_state in ('accepted', 'auto_accepted')
     and mi.status = 'in_progress'
     and coalesce(mi.last_confirmed_at, mi.created_at) + make_interval(days => %(days)s)
         between %(since)s and now()
)
"""


def normalize_since(since: datetime, now: datetime) -> datetime:
    """A naive timestamp is read as UTC. Refuses the future: nothing can have changed."""
    if since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    if since > now:
        raise HTTPException(422, "since must not be in the future")
    return since


@router.get("/digest", response_model=DigestResponse)
def digest(since: datetime, user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Changes to the caller's memories since `since` (ISO 8601): created, auto_accepted,
    edited, flagged_for_review, deleted, stale. Newest first, at most 200 entries;
    `counts` always covers every change, not only the entries returned.
    """
    since = normalize_since(since, datetime.now(UTC))
    params = {"user": user.id, "since": since, "days": settings.stale_after_days}
    cur.execute(
        DIGEST_EVENTS + """
        select ev.memory_item_id, mi.content, b.name as block_name, ev.change, ev.at
          from ev
          join memory_items mi on mi.id = ev.memory_item_id
          left join blocks b on b.id = mi.block_id
         order by ev.at desc, ev.memory_item_id
         limit %(limit)s""",
        {**params, "limit": DIGEST_LIMIT},
    )
    entries = [DigestEntry(**r) for r in cur.fetchall()]
    cur.execute(DIGEST_EVENTS + "select change, count(*) as n from ev group by change", params)
    return DigestResponse(since=since, entries=entries, counts={r["change"]: r["n"] for r in cur.fetchall()})
