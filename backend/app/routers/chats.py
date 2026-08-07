from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from app.config import settings
from app.db import db_cursor
from app.models import (
    CandidatesResponse,
    Chat,
    ChatCreate,
    ExtractionStatus,
    Message,
    MessageCreate,
    ScopeReport,
    TurnRequest,
    TurnResponse,
)
from app.routers.memory import ITEM_SELECT
from app.services import gemini
from app.services.extraction import run_extraction
from app.services.retrieval import retrieve

router = APIRouter(prefix="/chats", tags=["chats"])

HISTORY_TURNS = 12


@router.post("", response_model=Chat, status_code=201)
def create_chat(payload: ChatCreate, cur=Depends(db_cursor)):
    cur.execute(
        "insert into chats (user_id, title) values (%s, %s) returning *",
        (settings.demo_user_id, payload.title),
    )
    row = cur.fetchone()
    cur.connection.commit()
    return row


@router.get("", response_model=list[Chat])
def list_chats(cur=Depends(db_cursor)):
    cur.execute(
        "select * from chats where user_id = %s order by created_at desc",
        (settings.demo_user_id,),
    )
    return cur.fetchall()


@router.get("/{chat_id}/messages", response_model=list[Message])
def list_messages(chat_id: UUID, cur=Depends(db_cursor)):
    cur.execute("select * from messages where chat_id = %s order by created_at", (chat_id,))
    return cur.fetchall()


@router.post("/{chat_id}/messages", response_model=Message, status_code=201)
def add_message(chat_id: UUID, payload: MessageCreate, cur=Depends(db_cursor)):
    """Raw append, no LLM and no extraction. Kept for tests and seeding."""
    _assert_chat(cur, chat_id)
    cur.execute(
        """insert into messages (chat_id, role, content, session_ephemeral)
           values (%s, %s, %s, %s) returning *""",
        (chat_id, payload.role.value, payload.content, payload.session_ephemeral),
    )
    row = cur.fetchone()
    cur.connection.commit()
    return row


@router.post("/{chat_id}/message", response_model=TurnResponse)
def chat_turn(
    chat_id: UUID,
    payload: TurnRequest,
    background: BackgroundTasks,
    cur=Depends(db_cursor),
):
    """One full turn.

    Order matters: the response is produced and returned first, and extraction runs
    after. Extraction costs ~9s on Flash and putting it inline would make every turn
    feel broken (SYSTEM_DESIGN §5). The cost of async is that candidates arrive a
    moment after the reply, which the UI shows explicitly rather than hiding.
    """
    _assert_chat(cur, chat_id)

    # An ephemeral turn is marked at write time, so even a crash between here and the
    # extraction pass leaves a row that can never be extracted from.
    extraction_status = (
        ExtractionStatus.skipped if payload.session_ephemeral else ExtractionStatus.pending
    )
    cur.execute(
        """insert into messages (chat_id, role, content, session_ephemeral, extraction_status)
           values (%s, 'user', %s, %s, %s) returning *""",
        (chat_id, payload.content, payload.session_ephemeral, extraction_status.value),
    )
    user_msg = cur.fetchone()
    cur.connection.commit()

    if payload.selected_memory_ids:
        cur.execute(
            """select mi.id, mi.content, mi.status, mi.scope, mi.sensitivity, b.name as block_name, 0.0 as distance
               from memory_items mi
               left join blocks b on b.id = mi.block_id
               where mi.id = any(%s)""",
            ([str(i) for i in payload.selected_memory_ids],),
        )
        selected_rows = cur.fetchall()
        used = selected_rows if selected_rows else retrieve(cur, str(settings.demo_user_id), str(chat_id), payload.content)
    else:
        used = retrieve(cur, str(settings.demo_user_id), str(chat_id), payload.content)

    cur.execute(
        """select role, content from messages
           where chat_id = %s and role in ('user','assistant')
           order by created_at desc limit %s""",
        (chat_id, HISTORY_TURNS),
    )
    history = list(reversed(cur.fetchall()))

    try:
        reply = gemini.chat_response(history, used)
    except Exception as e:
        raise HTTPException(502, f"Gemini call failed: {type(e).__name__}: {e}") from e

    cur.execute(
        """insert into messages (chat_id, role, content, extraction_status)
           values (%s, 'assistant', %s, 'skipped') returning *""",
        (chat_id, reply),
    )
    assistant_msg = cur.fetchone()

    # Attribution rows are written now, at use time. P6 builds the revoke-and-regenerate
    # UI on top of these; recording them here costs nothing and means the history is
    # complete from the first turn rather than starting when P6 lands.
    for m in used:
        cur.execute(
            """insert into attributions (message_id, memory_item_id) values (%s, %s)
               on conflict do nothing""",
            (assistant_msg["id"], m["id"]),
        )
    cur.connection.commit()

    if not payload.session_ephemeral:
        background.add_task(
            run_extraction, str(user_msg["id"]), str(chat_id), str(settings.demo_user_id)
        )

    return {
        "user_message": user_msg,
        "assistant_message": assistant_msg,
        "used_memories": used,
        "extraction_running": not payload.session_ephemeral,
    }


@router.get("/{chat_id}/candidates", response_model=CandidatesResponse)
def turn_candidates(chat_id: UUID, message_id: UUID, cur=Depends(db_cursor)):
    """What extraction produced for one message. Polled by the review card.

    Splitting pending from auto-accepted in the response is the interruption budget
    made visible: the user sees what was taken silently, without being asked to
    approve it. Principle 2 is about not prompting, not about hiding.
    """
    cur.execute(
        "select extraction_status, extraction_error from messages where id = %s and chat_id = %s",
        (message_id, chat_id),
    )
    msg = cur.fetchone()
    if not msg:
        raise HTTPException(404, "message not found in this chat")

    cur.execute(
        f"{ITEM_SELECT} where mi.source_message_id = %s and mi.deleted_at is null "
        "order by mi.created_at",
        (message_id,),
    )
    items = cur.fetchall()

    return {
        "status": msg["extraction_status"],
        "error": msg["extraction_error"],
        "candidates": [i for i in items if i["review_state"] == "pending"],
        "auto_accepted": [i for i in items if i["review_state"] == "auto_accepted"],
    }


@router.get("/{chat_id}/scope-report", response_model=ScopeReport)
def scope_report(chat_id: UUID, cur=Depends(db_cursor)):
    """What this session can and cannot reach.

    Session scoping is enforced in two different places for two different reasons,
    and this endpoint reports on both:

    - **Ephemeral turns** never reach the extractor, so nothing is ever derived from
      them. `items_from_ephemeral_turns_global` counts memory items whose source
      message was ephemeral, across the whole database. It is structurally 0.
    - **Session-scoped items** do exist in the store, but retrieval filters them by
      `session_chat_id`. `hidden_session_items` is what a *different* chat holds that
      this one cannot use.
    """
    _assert_chat(cur, chat_id)
    live = "deleted_at is null and review_state in ('accepted','auto_accepted')"

    cur.execute(
        f"""select
              count(*) filter (where scope = 'persistent') as persistent,
              count(*) filter (where scope = 'session' and session_chat_id = %s) as session
            from memory_items where user_id = %s and {live}""",
        (chat_id, settings.demo_user_id),
    )
    visible = cur.fetchone()

    cur.execute(
        f"""select mi.id, mi.content, b.name as block_name, c.title as origin_chat_title
            from memory_items mi
            left join blocks b on b.id = mi.block_id
            left join chats c on c.id = mi.session_chat_id
            where mi.user_id = %s and mi.{live}
              and mi.scope = 'session'
              and mi.session_chat_id is distinct from %s
            order by mi.created_at desc""",
        (settings.demo_user_id, chat_id),
    )
    hidden = cur.fetchall()

    cur.execute(
        "select count(*) as n from messages where chat_id = %s and session_ephemeral",
        (chat_id,),
    )
    ephemeral_turns = cur.fetchone()["n"]

    cur.execute(
        """select count(*) as n from memory_items mi
           join messages m on m.id = mi.source_message_id
           where m.session_ephemeral"""
    )
    from_ephemeral = cur.fetchone()["n"]

    return {
        "chat_id": chat_id,
        "visible_persistent": visible["persistent"],
        "visible_session": visible["session"],
        "hidden_session_items": hidden,
        "ephemeral_turns": ephemeral_turns,
        "items_from_ephemeral_turns_global": from_ephemeral,
    }


@router.post("/{chat_id}/purge-ephemeral", response_model=dict)
def purge_ephemeral(chat_id: UUID, cur=Depends(db_cursor)):
    """Redact the text of off-the-record turns in this chat.

    Off the record governs *persistence*, not the current conversation: an ephemeral
    turn is still replayed as history within its own chat, because a model that
    cannot refer to what you said a moment ago is broken, not private. That text
    lives in `messages`, which is the transcript, not the memory store.

    This is the escape hatch for someone who wants it gone from the transcript too.
    Rows are redacted rather than deleted so the transcript still shows that
    something was said and withdrawn, instead of silently reshaping the history.
    """
    _assert_chat(cur, chat_id)
    cur.execute(
        """update messages set content = '[redacted — off the record]'
           where chat_id = %s and session_ephemeral
             and content <> '[redacted — off the record]'
           returning id""",
        (chat_id,),
    )
    redacted = len(cur.fetchall())
    cur.connection.commit()
    return {"redacted_turns": redacted}


def _assert_chat(cur, chat_id: UUID) -> None:
    cur.execute(
        "select 1 from chats where id = %s and user_id = %s", (chat_id, settings.demo_user_id)
    )
    if not cur.fetchone():
        raise HTTPException(404, "chat not found")
