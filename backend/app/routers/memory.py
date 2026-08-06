from __future__ import annotations

import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import settings
from app.db import db_cursor
from app.models import (
    AssertionStatus,
    Block,
    MemoryItem,
    MemoryItemCreate,
    MemoryItemEdit,
    RescopeRequest,
    ReviewState,
    Scope,
    Sensitivity,
)
from app.services import gemini

router = APIRouter(prefix="/memory", tags=["memory"])

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
        select id, name, default_sensitivity, restrictive_rank, is_fallback
        from blocks where user_id = %s
        order by restrictive_rank
        """,
        (settings.demo_user_id,),
    )
    return cur.fetchall()


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
        vec = str(gemini.embed([payload.content])[0])
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
            params.append(str(gemini.embed([payload.content])[0]))
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
# Still unbuilt. 501 with the phase, not 404 — "planned, not built" is a different
# claim from "does not exist". PHASES.md tracks these.
# --------------------------------------------------------------------------

def _todo(phase: str, what: str):
    raise HTTPException(501, f"{what} — implemented in {phase}")


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


@router.get("/items/{item_id}/graph")
def item_graph(item_id: UUID):
    _todo("P5", "provenance subgraph for deletion preview")


@router.delete("/items/{item_id}")
def delete_item(item_id: UUID):
    _todo("P5", "tombstone + cascade per SYSTEM_DESIGN §3")
