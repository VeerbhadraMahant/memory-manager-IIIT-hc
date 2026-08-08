from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import settings
from app.db import db_cursor
from app.models import (
    AssertionStatus,
    Block,
    BlockPrivacy,
    CascadePreview,
    MemoryItem,
    MemoryItemCreate,
    MemoryItemEdit,
    ProvenanceGraph,
    RescopeRequest,
    ReviewState,
    Scope,
    Sensitivity,
)
from app.services import llm

router = APIRouter(prefix="/memory", tags=["memory"])

# In-memory backing store for interactive subnodes (persists during backend runtime)
SUBNODES_STORE: dict[str, list[dict]] = {}


# Joined so the API never makes the client resolve a block id to a human label.
ITEM_SELECT = """
select mi.*, b.name as block_name
from memory_items mi
left join blocks b on b.id = mi.block_id
"""


@router.get("/blocks", response_model=list[Block])
def list_blocks(cur=Depends(db_cursor)):
    cur.execute(
        """
        select id, name, default_sensitivity, restrictive_rank, is_fallback,
               coalesce(private, false) as private
        from blocks where user_id = %s
        order by restrictive_rank
        """,
        (settings.demo_user_id,),
    )
    return cur.fetchall()


@router.patch("/blocks/{name}/privacy", response_model=Block)
def set_block_privacy(name: str, payload: BlockPrivacy, cur=Depends(db_cursor)):
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
        (settings.demo_user_id, name),
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
        """update blocks set private = %s
            where user_id = %s and name = %s
        returning id, name, default_sensitivity, restrictive_rank, is_fallback,
                  coalesce(private, false) as private""",
        (payload.private, settings.demo_user_id, name),
    )
    updated = cur.fetchone()
    cur.connection.commit()
    return updated


@router.get("/items", response_model=list[MemoryItem])
def list_items(
    cur=Depends(db_cursor),
    block: str | None = None,
    status: AssertionStatus | None = None,
    sensitivity: Sensitivity | None = None,
    scope: Scope | None = None,
    review_state: ReviewState | None = None,
    q: str | None = Query(None, description="substring match on content"),
    include_deleted: bool = False,
    limit: int = Query(200, le=1000),
):
    """Backs the P4 list view. Filters compose; all are optional."""
    where = ["mi.user_id = %s"]
    params: list = [settings.demo_user_id]

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
def get_item(item_id: UUID, cur=Depends(db_cursor)):
    cur.execute(f"{ITEM_SELECT} where mi.id = %s and mi.user_id = %s",
                (item_id, settings.demo_user_id))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "memory item not found")
    return row


@router.post("/items", response_model=MemoryItem, status_code=201)
def create_item(payload: MemoryItemCreate, cur=Depends(db_cursor)):
    """Direct insert. P1 replaces this as the *primary* path with extraction-driven
    candidate creation; it stays for tests and manual entry."""

    # Checked here for a clean 422, and again by the schema CHECK constraint.
    if payload.scope is Scope.session and payload.session_chat_id is None:
        raise HTTPException(422, "session-scoped items require session_chat_id")
    if payload.scope is Scope.persistent and payload.session_chat_id is not None:
        raise HTTPException(422, "persistent items must not carry session_chat_id")

    # Unknown or unnamed block -> the fallback block, which is the *most* restrictive
    # one, not a neutral bucket (D3).
    if payload.block_name:
        cur.execute("select id from blocks where user_id = %s and name = %s",
                    (settings.demo_user_id, payload.block_name))
        row = cur.fetchone()
        if not row:
            raise HTTPException(422, f"unknown block: {payload.block_name}")
        block_id = row["id"]
    else:
        cur.execute("select id from blocks where user_id = %s and is_fallback",
                    (settings.demo_user_id,))
        block_id = cur.fetchone()["id"]

    # Embed on create. Without this the item exists but is invisible to retrieval,
    # which is a confusing half-state: it shows in the list and never influences a
    # response. Extraction has always embedded; this path had not.
    try:
        vec = str(llm.embed([payload.content])[0])
    except Exception as e:
        raise HTTPException(502, f"could not embed content: {e}") from e

    cur.execute(
        """
        insert into memory_items (
            user_id, block_id, content, source_type, status, sensitivity, scope,
            confidence, source_message_id, session_chat_id, review_state, needs_review,
            embedding
        ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        returning id
        """,
        (
            settings.demo_user_id, block_id, payload.content,
            payload.source_type.value, payload.status.value,
            payload.sensitivity.value, payload.scope.value, payload.confidence,
            payload.source_message_id, payload.session_chat_id,
            payload.review_state.value, payload.needs_review, vec,
        ),
    )
    new_id = cur.fetchone()["id"]

    cur.execute(
        "insert into audit_log (memory_item_id, action, actor, detail) values (%s,%s,%s,%s)",
        (new_id, "created", "system", '{"via": "POST /memory/items"}'),
    )
    cur.connection.commit()

    cur.execute(f"{ITEM_SELECT} where mi.id = %s", (new_id,))
    return cur.fetchone()


# --------------------------------------------------------------------------
# Negotiation (P1). Every one of these is reachable from the review card inline in
# the conversation — memory formation is an in-conversation event, not a settings
# page (D1). They are also plain REST, so P4's list view reuses them unchanged.
# --------------------------------------------------------------------------

def _load(cur, item_id: UUID) -> dict:
    cur.execute(
        "select * from memory_items where id = %s and user_id = %s and deleted_at is null",
        (item_id, settings.demo_user_id),
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
def accept_item(item_id: UUID, cur=Depends(db_cursor)):
    _load(cur, item_id)
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
def reject_item(item_id: UUID, cur=Depends(db_cursor)):
    """Rejection tombstones rather than deletes.

    The audit trail is the point: "the system proposed this and the user said no" is
    a different and more useful record than the row never having existed. Rejected
    items are excluded from retrieval by review_state, so this costs nothing at
    use time.
    """
    _load(cur, item_id)
    cur.execute(
        "update memory_items set review_state = 'rejected', deleted_at = now() where id = %s",
        (item_id,),
    )
    _audit(cur, item_id, "rejected")
    cur.connection.commit()
    cur.execute(f"{ITEM_SELECT} where mi.id = %s", (item_id,))
    return cur.fetchone()


@router.patch("/items/{item_id}", response_model=MemoryItem)
def edit_item(item_id: UUID, payload: MemoryItemEdit, cur=Depends(db_cursor)):
    """Correct the item in place.

    A correction is an acceptance: the user has looked at it and said what it should
    say, so there is no reason to make them press accept afterwards. Editing the
    content re-embeds, or retrieval would keep matching the wording the user rejected.
    """
    before = _load(cur, item_id)

    sets: list[str] = []
    params: list = []
    changed: dict = {}

    if payload.content is not None and payload.content != before["content"]:
        sets.append("content = %s")
        params.append(payload.content)
        changed["content"] = {"from": before["content"], "to": payload.content}
        try:
            sets.append("embedding = %s")
            params.append(str(llm.embed([payload.content])[0]))
        except Exception as e:
            raise HTTPException(502, f"could not re-embed edited content: {e}") from e

    for field in ("status", "sensitivity"):
        val = getattr(payload, field)
        if val is not None and val.value != before[field]:
            sets.append(f"{field} = %s")
            params.append(val.value)
            changed[field] = {"from": before[field], "to": val.value}

    if payload.block_name is not None:
        cur.execute(
            "select id, name from blocks where user_id = %s and name = %s",
            (settings.demo_user_id, payload.block_name),
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
    cur.connection.commit()
    return _return(cur, item_id)


@router.post("/items/{item_id}/rescope", response_model=MemoryItem)
def rescope_item(item_id: UUID, payload: RescopeRequest, cur=Depends(db_cursor)):
    """Move an item between session and persistent.

    Demoting to session needs a chat to anchor to (D14); the source message's chat is
    the only defensible choice, since that is the conversation the fact was disclosed in.
    """
    before = _load(cur, item_id)
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
def confirm_item(item_id: UUID, cur=Depends(db_cursor)):
    """"Yes, this is still true." Resets the decay clock.

    Decay is not deletion — a stale item is still used, just never asserted as current
    without a re-check. Confirming is the cheapest possible correction, which is the
    point: the alternative to a one-tap confirm is silent reuse of a fact that has
    quietly stopped being true (D4).
    """
    _load(cur, item_id)
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
       mi.last_confirmed_at, mi.deleted_at
from memory_items mi
left join blocks b on b.id = mi.block_id
"""

# Only these two relations carry derivation, so only these two cascade.
# `contradicts` and `updates` describe how two independent facts relate; deleting
# one end invalidates the *relationship claim*, not the other fact.
DERIVING = ("derived_from", "summarized_from")


def _cascade(cur, root_id: UUID) -> tuple[CascadePreview, set[UUID]]:
    """Walk the derivation edges out of `root_id` and classify what it reaches.

    Returns the preview and the full set of item ids touched, so the caller can
    render exactly the subgraph the preview describes rather than a different one.
    """
    cascade_delete: list[UUID] = []
    flag_for_review: list[UUID] = []
    touched: set[UUID] = {root_id}

    # BFS, not recursion: a `derived_from` chain is user-generated data and a
    # cycle would be a stack overflow rather than a bug report. `seen` also makes
    # a diamond (two paths to the same dependent) resolve once.
    frontier = [root_id]
    seen: set[UUID] = {root_id}
    while frontier:
        current = frontier.pop(0)
        cur.execute(
            """select e.to_item_id
               from memory_edges e
               join memory_items mi on mi.id = e.to_item_id
               where e.from_item_id = %s and e.relation = any(%s)
                 and mi.deleted_at is null""",
            (current, list(DERIVING)),
        )
        for row in cur.fetchall():
            dependent = row["to_item_id"]
            touched.add(dependent)
            if dependent in seen:
                continue
            seen.add(dependent)

            # Does anything *other than what we are deleting* still support it?
            cur.execute(
                """select count(*) as n
                   from memory_edges e
                   join memory_items mi on mi.id = e.from_item_id
                   where e.to_item_id = %s and e.relation = any(%s)
                     and not (e.from_item_id = any(%s)) and mi.deleted_at is null""",
                (dependent, list(DERIVING), list(seen)),
            )
            if cur.fetchone()["n"] > 0:
                # Survives, but on a thinner evidence base than it was written on.
                # Not re-derived — flagged, and the UI says so (SYSTEM_DESIGN §3 step 2).
                flag_for_review.append(dependent)
            else:
                cascade_delete.append(dependent)
                frontier.append(dependent)

    # Relationship edges in either direction: the other end is still true, but the
    # statement "these two disagree" / "this supersedes that" loses one of its ends.
    cur.execute(
        """select distinct case when e.from_item_id = %s then e.to_item_id
                                else e.from_item_id end as other_id
           from memory_edges e
           join memory_items mi
             on mi.id = case when e.from_item_id = %s then e.to_item_id else e.from_item_id end
           where (e.from_item_id = %s or e.to_item_id = %s)
             and e.relation in ('contradicts', 'updates')
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
def full_graph(cur=Depends(db_cursor), limit: int = Query(GRAPH_NODE_CAP, le=500)):
    """Every live item and every edge between them — the graph view's backing data.

    Capped, and it reports when it capped. A view that silently shows 150 of 400
    memories is a worse lie than one that refuses to draw.
    """
    cur.execute(
        f"{GRAPH_SELECT} where mi.user_id = %s and mi.deleted_at is null "
        f"and mi.review_state <> 'rejected' order by mi.created_at desc limit %s",
        (settings.demo_user_id, limit + 1),
    )
    rows = cur.fetchall()
    truncated = len(rows) > limit
    rows = rows[:limit]

    ids = [r["id"] for r in rows]
    edges = []
    if ids:
        cur.execute(
            """select from_item_id, to_item_id, relation from memory_edges
               where from_item_id = any(%s) and to_item_id = any(%s)""",
            (ids, ids),
        )
        edges = cur.fetchall()

    return ProvenanceGraph(nodes=rows, edges=edges, truncated=truncated)


@router.get("/items/{item_id}/graph", response_model=ProvenanceGraph)
def item_graph(item_id: UUID, cur=Depends(db_cursor)):
    """The deletion preview, as data. Answers exactly one question."""
    _load(cur, item_id)
    cascade, touched = _cascade(cur, item_id)

    ids = list(touched)
    cur.execute(f"{GRAPH_SELECT} where mi.id = any(%s)", (ids,))
    nodes = cur.fetchall()

    cur.execute(
        """select from_item_id, to_item_id, relation from memory_edges
           where from_item_id = any(%s) and to_item_id = any(%s)""",
        (ids, ids),
    )
    return ProvenanceGraph(
        root_id=item_id, nodes=nodes, edges=cur.fetchall(), cascade=cascade
    )


@router.delete("/items/{item_id}")
def delete_item(item_id: UUID):
    _todo("P5", "tombstone + cascade per SYSTEM_DESIGN §3")
