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


def _assert_chat(cur, chat_id: UUID) -> None:
    cur.execute(
        "select 1 from chats where id = %s and user_id = %s", (chat_id, settings.demo_user_id)
    )
    if not cur.fetchone():
        raise HTTPException(404, "chat not found")
