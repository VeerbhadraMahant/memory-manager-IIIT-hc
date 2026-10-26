from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.auth import User, current_user, forget_user
from app.db import db_cursor
from app.models import Me
from app.ratelimit import general_limit

router = APIRouter(tags=["account"], dependencies=[Depends(general_limit)])


@router.get("/me", response_model=Me)
def me(user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Who the request is acting as, for the sidebar's profile entry.

    Reads the `users` row so what the UI shows is a fact from the database.
    `is_demo_user` says plainly when no one is signed in.
    """
    cur.execute(
        "select id, handle, email, name, avatar_url, created_at from users where id = %s",
        (user.id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(500, "configured demo user does not exist — run migrate.py")
    return Me(**row, is_demo_user=user.is_demo)


@router.get("/me/export")
def export_my_data(user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Everything stored about the caller, as JSON (data portability).

    Embeddings are omitted — they are derived, large, and meaningless to a person.
    Tombstoned rows are included: they are still stored, so an export that hid them
    would understate what the system holds.
    """
    out: dict = {}
    queries = {
        "profile": "select id, handle, email, name, created_at from users where id = %(u)s",
        "blocks": "select name, default_sensitivity, restrictive_rank, is_fallback, private from blocks where user_id = %(u)s order by restrictive_rank",
        "chats": "select * from chats where user_id = %(u)s order by created_at",
        "messages": """select m.* from messages m join chats c on c.id = m.chat_id
                       where c.user_id = %(u)s order by m.created_at""",
        "memory_items": """select id, block_id, content, evidence, source_type, status, sensitivity, scope,
                                  confidence, source_message_id, session_chat_id, review_state, needs_review,
                                  review_reason, created_at, last_confirmed_at, deleted_at
                           from memory_items where user_id = %(u)s order by created_at""",
        "memory_subnodes": "select * from memory_subnodes where user_id = %(u)s order by created_at",
        "memory_edges": """select e.* from memory_edges e join memory_items mi on mi.id = e.from_item_id
                           where mi.user_id = %(u)s""",
        "audit_log": """select a.* from audit_log a
                        where a.memory_item_id in (select id from memory_items where user_id = %(u)s)
                        order by a.created_at""",
    }
    for key, sql in queries.items():
        cur.execute(sql, {"u": user.id})
        out[key] = cur.fetchall()
    return out


@router.delete("/me")
def delete_my_account(user: User = Depends(current_user), cur=Depends(db_cursor, scope="function")):
    """Permanently erase the caller and everything they stored.

    Unlike item deletion (a tombstone, so provenance survives) this is a true erase —
    the user is leaving, and the point of the tombstone policy is protecting *their*
    audit trail. Order matters: `memory_items.source_message_id` is ON DELETE RESTRICT
    (principle 7), so items must go before the messages their chats cascade away.
    """
    if user.is_demo:
        raise HTTPException(403, "the shared demo account cannot be deleted")
    cur.execute(
        "delete from audit_log where memory_item_id in (select id from memory_items where user_id = %s)",
        (user.id,),
    )
    cur.execute("delete from memory_items where user_id = %s", (user.id,))
    cur.execute("delete from users where id = %s", (user.id,))
    forget_user(user.id)
    return {"status": "deleted"}
