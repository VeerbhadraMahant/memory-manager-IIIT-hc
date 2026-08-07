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
    MemoryItem,
    MemoryItemCreate,
    MemoryItemEdit,
    MemorySubnode,
    NodeSummaryResponse,
    PruneResponse,
    RelevanceRequest,
    RelevanceResponse,
    RescopeRequest,
    ReviewState,
    Scope,
    Sensitivity,
    SubnodeCreate,
    SubnodeEdit,
)
from app.services import gemini

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

    cur.execute(
        """
        insert into memory_items (
            user_id, block_id, content, source_type, status, sensitivity, scope,
            confidence, source_message_id, session_chat_id, review_state, needs_review
        ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        returning id
        """,
        (
            settings.demo_user_id, block_id, payload.content,
            payload.source_type.value, payload.status.value,
            payload.sensitivity.value, payload.scope.value, payload.confidence,
            payload.source_message_id, payload.session_chat_id,
            payload.review_state.value, payload.needs_review,
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


@router.post("/items/{item_id}/confirm")
def confirm_item(item_id: UUID):
    _todo("P6", "confirm a stale item and reset the decay clock")


@router.get("/items/{item_id}/graph")
def item_graph(item_id: UUID):
    _todo("P5", "provenance subgraph for deletion preview")


@router.delete("/items/{item_id}")
def delete_item(item_id: UUID):
    _todo("P5", "tombstone + cascade per SYSTEM_DESIGN §3")


# --------------------------------------------------------------------------
# Hierarchical Subnodes & Graph Endpoints
# --------------------------------------------------------------------------

def _seed_subnodes_for_item(item_id_str: str, item_content: str, block_name: str | None) -> list[dict]:
    """Auto-seeds initial granular subnodes for a memory node if not already present."""
    if item_id_str in SUBNODES_STORE:
        return SUBNODES_STORE[item_id_str]

    now = datetime.now(timezone.utc)
    category = block_name or "General"
    
    # Generate 3 default contextual subnodes based on content
    words = item_content.split()
    first_part = " ".join(words[:min(5, len(words))])
    second_part = " ".join(words[min(5, len(words)):min(10, len(words))]) if len(words) > 5 else "Context details"

    seeds = [
        {
            "id": str(uuid4()),
            "memory_item_id": item_id_str,
            "content": f"Core Fact: {first_part}",
            "confidence": 0.95,
            "category": category,
            "created_at": now.isoformat(),
        },
        {
            "id": str(uuid4()),
            "memory_item_id": item_id_str,
            "content": f"Supporting Evidence: {second_part}",
            "confidence": 0.88,
            "category": category,
            "created_at": now.isoformat(),
        },
        {
            "id": str(uuid4()),
            "memory_item_id": item_id_str,
            "content": f"Classification: Categorized under {category}",
            "confidence": 0.92,
            "category": category,
            "created_at": now.isoformat(),
        },
    ]
    SUBNODES_STORE[item_id_str] = seeds
    return seeds


@router.get("/items/{item_id}/subnodes", response_model=list[MemorySubnode])
def get_subnodes(item_id: UUID, cur=Depends(db_cursor)):
    item_id_str = str(item_id)
    cur.execute("select mi.content, b.name as block_name from memory_items mi left join blocks b on b.id = mi.block_id where mi.id = %s", (item_id,))
    row = cur.fetchone()
    content = row["content"] if row else "Memory node detail"
    block_name = row["block_name"] if row else None
    
    subnodes = _seed_subnodes_for_item(item_id_str, content, block_name)
    return subnodes


@router.post("/items/{item_id}/subnodes", response_model=MemorySubnode, status_code=201)
def create_subnode(item_id: UUID, payload: SubnodeCreate, cur=Depends(db_cursor)):
    item_id_str = str(item_id)
    cur.execute("select mi.content, b.name as block_name from memory_items mi left join blocks b on b.id = mi.block_id where mi.id = %s", (item_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "memory item not found")

    _seed_subnodes_for_item(item_id_str, row["content"], row["block_name"])
    
    new_subnode = {
        "id": str(uuid4()),
        "memory_item_id": item_id_str,
        "content": payload.content,
        "confidence": payload.confidence,
        "category": payload.category or row["block_name"] or "General",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    SUBNODES_STORE[item_id_str].append(new_subnode)
    return new_subnode


@router.patch("/subnodes/{subnode_id}", response_model=MemorySubnode)
def edit_subnode(subnode_id: UUID, payload: SubnodeEdit):
    sub_id_str = str(subnode_id)
    for item_id_str, sublist in SUBNODES_STORE.items():
        for subnode in sublist:
            if subnode["id"] == sub_id_str:
                if payload.content is not None:
                    subnode["content"] = payload.content
                if payload.confidence is not None:
                    subnode["confidence"] = payload.confidence
                if payload.category is not None:
                    subnode["category"] = payload.category
                return subnode
    raise HTTPException(404, "subnode not found")


@router.delete("/subnodes/{subnode_id}")
def delete_subnode(subnode_id: UUID):
    sub_id_str = str(subnode_id)
    for item_id_str, sublist in SUBNODES_STORE.items():
        for idx, subnode in enumerate(sublist):
            if subnode["id"] == sub_id_str:
                sublist.pop(idx)
                return {"status": "deleted", "id": sub_id_str}
    raise HTTPException(404, "subnode not found")


@router.post("/items/{item_id}/prune", response_model=PruneResponse)
def prune_subnodes(item_id: UUID, cur=Depends(db_cursor)):
    item_id_str = str(item_id)
    subnodes = SUBNODES_STORE.get(item_id_str, [])
    
    # Prune low confidence (< 0.7) or duplicate subnodes
    initial_count = len(subnodes)
    seen_contents = set()
    kept = []
    for sub in subnodes:
        if sub["confidence"] >= 0.7 and sub["content"].lower() not in seen_contents:
            seen_contents.add(sub["content"].lower())
            kept.append(sub)
            
    pruned_count = initial_count - len(kept)
    SUBNODES_STORE[item_id_str] = kept
    return PruneResponse(
        pruned_count=pruned_count,
        message=f"Pruned {pruned_count} redundant or low-confidence subnodes." if pruned_count > 0 else "All subnodes passed confidence threshold."
    )


@router.get("/items/{item_id}/summary", response_model=NodeSummaryResponse)
def get_node_summary(item_id: UUID, cur=Depends(db_cursor)):
    item_id_str = str(item_id)
    cur.execute("select mi.*, b.name as block_name from memory_items mi left join blocks b on b.id = mi.block_id where mi.id = %s", (item_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "memory item not found")

    content = row["content"]
    category = row["block_name"] or "General"
    subnodes = SUBNODES_STORE.get(item_id_str, _seed_subnodes_for_item(item_id_str, content, category))

    sub_texts = [s["content"] for s in subnodes]
    key_points = sub_texts if sub_texts else [content]
    
    summary_text = f"Node '{category}': {content}. Context is composed of {len(subnodes)} active subnodes covering core facts, supporting evidence, and category metadata."
    
    return NodeSummaryResponse(
        memory_item_id=item_id,
        title=f"Summary of {category} Node",
        summary=summary_text,
        key_points=key_points,
        subnode_count=len(subnodes),
    )


@router.post("/relevance", response_model=RelevanceResponse)
def compute_prompt_relevance(payload: RelevanceRequest, cur=Depends(db_cursor)):
    prompt = payload.prompt.lower().strip()
    cur.execute("select id, content from memory_items where deleted_at is null")
    items = cur.fetchall()

    prompt_words = set(w for w in prompt.split() if len(w) > 2)
    scores: dict[str, float] = {}

    for item in items:
        item_id_str = str(item["id"])
        item_text = item["content"].lower()
        subnodes = SUBNODES_STORE.get(item_id_str, [])
        combined_text = item_text + " " + " ".join(s["content"].lower() for s in subnodes)

        if not prompt_words:
            scores[item_id_str] = 0.0
            continue

        match_count = sum(1 for w in prompt_words if w in combined_text)
        # Substring exact match bonus
        bonus = 0.3 if prompt in combined_text else 0.0
        
        score = min(1.0, (match_count / len(prompt_words)) * 0.8 + bonus)
        scores[item_id_str] = round(score, 3)

    return RelevanceResponse(scores=scores)

