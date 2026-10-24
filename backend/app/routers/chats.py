from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from app.auth import User, current_user
from app.db import db_cursor, pool
from app.models import (
    AssertionStatus,
    CandidatesResponse,
    Chat,
    ChatCreate,
    ChatDeleted,
    ChatUpdate,
    DraftRequest,
    ExtractionStatus,
    InfluenceRequest,
    InfluenceResponse,
    MemoryInfluence,
    Message,
    MessageCreate,
    RegenerateRequest,
    RegenerateResponse,
    ScopeReport,
    TurnRequest,
    TurnResponse,
    VerifiedDraft,
)
from app.ratelimit import general_limit, llm_limit
from app.routers.memory import ITEM_SELECT, _audit
from app.services import llm
from app.services.classify import check_claim, influence
from app.services.extraction import run_extraction
from app.services.retrieval import (
    embed_query,
    influence_verdict,
    pinned,
    retrieve,
    retrieve_traced,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/chats", tags=["chats"], dependencies=[Depends(general_limit)])

HISTORY_TURNS = 12


@router.get("/providers", tags=["meta"])
def list_providers():
    """Chat providers with a key configured, for the model switcher (D32).

    Declared before `/{chat_id}` so the literal path is not swallowed by the UUID
    route. Reports configuration, not reachability — a listed provider can still
    fail on an invalid key or a retired model, and that surfaces on the turn.
    """
    return {"providers": llm.available_providers(), "default": llm.resolve_provider(None)}


@router.post("", response_model=Chat, status_code=201)
def create_chat(payload: ChatCreate, user: User = Depends(current_user), cur=Depends(db_cursor)):
    cur.execute(
        "insert into chats (user_id, title) values (%s, %s) returning *",
        (user.id, payload.title),
    )
    row = cur.fetchone()
    cur.connection.commit()
    return row


@router.get("", response_model=list[Chat])
def list_chats(user: User = Depends(current_user), cur=Depends(db_cursor)):
    cur.execute(
        """select * from chats
            where user_id = %s and deleted_at is null
            order by created_at desc""",
        (user.id,),
    )
    return cur.fetchall()


@router.patch("/{chat_id}", response_model=Chat)
def rename_chat(chat_id: UUID, payload: ChatUpdate, user: User = Depends(current_user), cur=Depends(db_cursor)):
    _assert_chat(cur, chat_id, user.id)
    cur.execute(
        "update chats set title = %s where id = %s and user_id = %s returning *",
        (payload.title, chat_id, user.id),
    )
    row = cur.fetchone()
    cur.connection.commit()
    return row


@router.delete("/{chat_id}", response_model=ChatDeleted)
def delete_chat(chat_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor)):
    """Tombstone a chat, and with it the memories that were confined to it.

    Not a row delete — see migration 006 for why the schema forbids one. The split
    below is the whole decision:

      * session-scoped items anchored to this chat are tombstoned. They were only
        ever usable inside it, so leaving them would be unreachable dead weight
        that still counts in the store.
      * persistent items are left alone. The user promoted those out of the chat
        deliberately, and deleting a conversation is not a retraction of that.
      * message rows stay, so every surviving item's `source_message_id` still
        resolves and its evidence quote still renders (principle 7).

    Each tombstoned item gets an audit row naming the chat, so "why did this
    disappear" has an answer that is not "we assume the chat deletion did it".
    """
    _assert_chat(cur, chat_id, user.id)

    cur.execute(
        """update memory_items
              set deleted_at = now()
            where user_id = %s and session_chat_id = %s and deleted_at is null
        returning id""",
        (user.id, chat_id),
    )
    removed = [row["id"] for row in cur.fetchall()]
    for item_id in removed:
        _audit(cur, item_id, "deleted_with_chat", {"chat_id": str(chat_id)})

    # Counted, not assumed: the reply says how many memories outlived the chat, so
    # the confirmation the user sees is the database's answer rather than the UI's.
    cur.execute(
        """select count(*) as n
             from memory_items mi
             join messages m on m.id = mi.source_message_id
            where mi.user_id = %s and m.chat_id = %s and mi.deleted_at is null""",
        (user.id, chat_id),
    )
    kept = cur.fetchone()["n"]

    cur.execute("update chats set deleted_at = now() where id = %s", (chat_id,))
    cur.connection.commit()

    return ChatDeleted(
        chat_id=chat_id,
        session_memories_removed=len(removed),
        persistent_memories_kept=kept,
    )


@router.get("/{chat_id}/messages", response_model=list[Message])
def list_messages(chat_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor)):
    # Guarded like every other chat route. Without this it happily served the
    # transcript of a chat the user had deleted — harmless while there is one
    # hardcoded user, a cross-account read the moment there is more than one.
    _assert_chat(cur, chat_id, user.id)
    cur.execute("select * from messages where chat_id = %s order by created_at", (chat_id,))
    return cur.fetchall()


@router.post("/{chat_id}/messages", response_model=Message, status_code=201)
def add_message(chat_id: UUID, payload: MessageCreate, user: User = Depends(current_user), cur=Depends(db_cursor)):
    """Raw append, no LLM and no extraction. Kept for tests and seeding."""
    _assert_chat(cur, chat_id, user.id)
    cur.execute(
        """insert into messages (chat_id, role, content, session_ephemeral)
           values (%s, %s, %s, %s) returning *""",
        (chat_id, payload.role.value, payload.content, payload.session_ephemeral),
    )
    row = cur.fetchone()
    cur.connection.commit()
    return row


@router.post("/{chat_id}/message", response_model=TurnResponse, dependencies=[Depends(llm_limit)])
def chat_turn(
    chat_id: UUID,
    payload: TurnRequest,
    background: BackgroundTasks,
    user: User = Depends(current_user),
):
    """One full turn.

    Order matters: the response is produced and returned first, and extraction runs
    after. Extraction costs ~9s on Flash and putting it inline would make every turn
    feel broken (SYSTEM_DESIGN §5). The cost of async is that candidates arrive a
    moment after the reply, which the UI shows explicitly rather than hiding.

    Database connections are held only around database work. The two network calls
    (embedding, chat completion) take seconds each; holding a pooled connection across
    them meant `db_pool_max` concurrent turns exhausted the pool and everything else
    queued behind LLM latency.
    """
    uid, cid = str(user.id), str(chat_id)
    # A guest turn is never extracted from, and sees only low-sensitivity memory.
    ephemeral = payload.session_ephemeral or payload.guest
    cap = "low" if payload.guest else None

    with pool.connection() as conn, conn.cursor() as cur:
        _assert_chat(cur, chat_id, user.id)

        # An ephemeral turn is marked at write time, so even a crash between here and
        # the extraction pass leaves a row that can never be extracted from.
        extraction_status = (
            ExtractionStatus.skipped if ephemeral else ExtractionStatus.pending
        )
        cur.execute(
            """insert into messages (chat_id, role, content, session_ephemeral, extraction_status)
               values (%s, 'user', %s, %s, %s) returning *""",
            (chat_id, payload.content, ephemeral, extraction_status.value),
        )
        user_msg = cur.fetchone()

        used: list[dict] = []
        trace = None
        if payload.selected_memory_ids:
            used, trace = pinned(
                cur, uid, cid, payload.content, [str(i) for i in payload.selected_memory_ids],
                destination="chat", max_sensitivity=cap,
            )

        cur.execute(
            """select role, content from messages
               where chat_id = %s and role in ('user','assistant')
               order by created_at desc limit %s""",
            (chat_id, HISTORY_TURNS),
        )
        history = list(reversed(cur.fetchall()))

    if trace is None or not used:
        vec = embed_query(payload.content)  # network, no connection held
        with pool.connection() as conn, conn.cursor() as cur:
            used, trace = retrieve_traced(
                cur, uid, cid, payload.content, vec=vec,
                destination="chat", max_sensitivity=cap,
            )
            if vec is None:
                trace.embedding_failed = True

    # The provider is chosen per turn, but the memory above was already retrieved —
    # switching models carries the memory across rather than re-deriving it (D32).
    try:
        reply, provider_used, model_used, reasoning = llm.chat_response(
            history, used, payload.provider
        )
    except Exception as e:
        log.exception("chat completion failed")
        raise HTTPException(502, f"LLM call failed: {llm.public_error(e)}") from e

    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """insert into messages (chat_id, role, content, extraction_status, provider, model)
               values (%s, 'assistant', %s, 'skipped', %s, %s) returning *""",
            (chat_id, reply, provider_used, model_used),
        )
        assistant_msg = cur.fetchone()

        # Attribution rows are written now, at use time. P6 builds the revoke-and-regenerate
        # UI on top of these; recording them here costs nothing and means the history is
        # complete from the first turn rather than starting when P6 lands.
        _record_attributions(cur, assistant_msg["id"], used)

    if not ephemeral:
        background.add_task(run_extraction, str(user_msg["id"]), cid, uid)

    return {
        "user_message": user_msg,
        "assistant_message": assistant_msg,
        "used_memories": used,
        "extraction_running": not ephemeral,
        # Which model actually answered, not which was asked for — an unconfigured
        # or stale selection falls back, and that should be visible rather than silent.
        "provider": provider_used,
        "model": model_used,
        # The model's own scratchpad, verbatim, or "" when it emitted none. Never
        # synthesised — a UI that invents plausible reasoning is worse than one that
        # shows none, because it cannot be told apart from the real thing.
        "reasoning": reasoning,
        # How the memories above were chosen, including what was considered and
        # rejected. This is the retrieval claim made checkable rather than asserted.
        "retrieval": trace.as_dict(),
    }


def _record_attributions(cur, message_id, used: list[dict]) -> None:
    if used:
        cur.executemany(
            """insert into attributions (message_id, memory_item_id) values (%s, %s)
               on conflict do nothing""",
            [(message_id, m["id"]) for m in used],
        )


@router.get("/{chat_id}/candidates", response_model=CandidatesResponse)
def turn_candidates(chat_id: UUID, message_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor)):
    """What extraction produced for one message. Polled by the review card.

    Splitting pending from auto-accepted in the response is the interruption budget
    made visible: the user sees what was taken silently, without being asked to
    approve it. Principle 2 is about not prompting, not about hiding.
    """
    _assert_chat(cur, chat_id, user.id)
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


@router.post("/{chat_id}/regenerate", response_model=RegenerateResponse, dependencies=[Depends(llm_limit)])
def regenerate(chat_id: UUID, payload: RegenerateRequest, user: User = Depends(current_user)):
    """Answer the same turn again, without the memories the user just revoked.

    Revoking is a memory-level act, not a display filter: the items are rejected and
    tombstoned, so they will not come back on the next turn either. Returning the old
    and new answers side by side is the point — "here is what I would have said
    without that" is the thing that makes the influence legible.
    """
    uid, cid = str(user.id), str(chat_id)

    with pool.connection() as conn, conn.cursor() as cur:
        _assert_chat(cur, chat_id, user.id)

        cur.execute(
            "select * from messages where id = %s and chat_id = %s and role = 'assistant'",
            (payload.message_id, chat_id),
        )
        target = cur.fetchone()
        if not target:
            raise HTTPException(404, "assistant message not found in this chat")

        # The user turn this reply answered.
        cur.execute(
            """select content from messages
               where chat_id = %s and role = 'user' and created_at < %s
               order by created_at desc limit 1""",
            (chat_id, target["created_at"]),
        )
        prompt_row = cur.fetchone()
        if not prompt_row:
            raise HTTPException(422, "no user turn precedes that reply")

        revoked: list[dict] = []
        # exclude_all is a comparison, not a decision: nothing is revoked or tombstoned.
        for item_id in [] if payload.exclude_all else payload.revoke_item_ids:
            cur.execute(
                """update memory_items
                   set review_state = 'rejected', deleted_at = now()
                   where id = %s and user_id = %s and deleted_at is null
                   returning id, content, status, scope, sensitivity, block_id""",
                (item_id, user.id),
            )
            row = cur.fetchone()
            if row:
                revoked.append({**row, "block_name": None, "distance": 0.0, "is_stale": False})
                cur.execute(
                    """insert into audit_log (memory_item_id, action, actor, detail)
                       values (%s, 'revoked_at_use_time', 'user', %s)""",
                    (item_id, json.dumps({"message_id": str(payload.message_id)})),
                )
                # Attributions on *other* replies stay: those answers were shaped by
                # this memory, and revoking it now does not change that. Only the
                # regenerated reply's attributions are replaced, below.

        cur.execute(
            """select role, content from messages
               where chat_id = %s and role in ('user','assistant') and created_at < %s
               order by created_at desc limit %s""",
            (chat_id, target["created_at"], HISTORY_TURNS),
        )
        history = list(reversed(cur.fetchall()))

    used: list[dict] = []
    if not payload.exclude_all:
        vec = embed_query(prompt_row["content"])
        with pool.connection() as conn, conn.cursor() as cur:
            used = retrieve(
                cur, uid, cid, prompt_row["content"],
                exclude={str(i) for i in payload.revoke_item_ids}, vec=vec,
                destination="chat",
            )

    try:
        reply, provider_used, model_used, _ = llm.chat_response(history, used, payload.provider)
    except Exception as e:
        log.exception("regenerate completion failed")
        raise HTTPException(502, f"chat call failed: {llm.public_error(e)}") from e

    if payload.exclude_all:
        # The stored reply and its attributions stay as they were; the no-memory answer
        # is returned for comparison only.
        updated = target
    else:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "update messages set content = %s, provider = %s, model = %s"
                " where id = %s returning *",
                (reply, provider_used, model_used, target["id"]),
            )
            updated = cur.fetchone()
            cur.execute("delete from attributions where message_id = %s", (target["id"],))
            _record_attributions(cur, target["id"], used)

    return {
        "previous": target["content"],
        "regenerated": reply,
        "revoked": revoked,
        "used_memories": used,
        "assistant_message": updated,
    }


@router.post(
    "/{chat_id}/messages/{message_id}/influence",
    response_model=InfluenceResponse,
    dependencies=[Depends(llm_limit)],
)
def message_influence(
    chat_id: UUID, message_id: UUID, payload: InfluenceRequest, user: User = Depends(current_user)
):
    """Measure, by regenerating, how much each attributed memory moved this reply.

    For k attributed memories this makes k ablated calls plus `payload.repeats`
    full-context calls, all on the provider stored on the message. The repeats give a
    noise floor: how far the same prompt drifts from itself. A score is a text distance
    above that floor, not proof of cause. Nothing is tombstoned or attributed here.
    """
    with pool.connection() as conn, conn.cursor() as cur:
        _assert_chat(cur, chat_id, user.id)
        cur.execute(
            "select * from messages where id = %s and chat_id = %s and role = 'assistant'",
            (message_id, chat_id),
        )
        target = cur.fetchone()
        if not target:
            raise HTTPException(404, "assistant message not found in this chat")
        cur.execute(
            """select mi.id, mi.content, mi.status
               from attributions a join memory_items mi on mi.id = a.memory_item_id
               where a.message_id = %s and mi.user_id = %s and mi.deleted_at is null
               order by mi.created_at""",
            (message_id, user.id),
        )
        memories = [{**r, "is_stale": False} for r in cur.fetchall()]
        cur.execute(
            """select role, content from messages
               where chat_id = %s and role in ('user','assistant') and created_at < %s
               order by created_at desc limit %s""",
            (chat_id, target["created_at"], HISTORY_TURNS),
        )
        history = list(reversed(cur.fetchall()))

    # No stored provider (a message from before migration 010): the default is used and
    # reported in the response rather than guessed to be the original.
    provider = target["provider"] or llm.resolve_provider(None)
    model = target["model"]
    calls = 0

    def run(mems: list[dict]) -> str | None:
        nonlocal calls, model
        calls += 1
        try:
            reply, _, model_used, _ = llm.chat_response(history, mems, provider)
        except Exception:
            log.exception("influence regeneration failed")
            return None
        model = model or model_used
        return reply

    if not memories:
        return InfluenceResponse(
            message_id=message_id, provider=provider, model=model,
            noise_floor=0.0, calls_made=0, results=[],
        )

    repeats = [run(memories) for _ in range(payload.repeats)]
    ok_repeats = [r for r in repeats if r is not None]
    noise_floor = 0.0
    results: list[MemoryInfluence] = []
    for m in memories:
        ablated = run([x for x in memories if x["id"] != m["id"]])
        score = None
        if ablated is not None and len(ok_repeats) >= 2:
            score, noise_floor = influence(target["content"], ablated, ok_repeats)
        results.append(MemoryInfluence(
            memory_item_id=m["id"], score=score, verdict=influence_verdict(score)
        ))
    return InfluenceResponse(
        message_id=message_id, provider=provider, model=model,
        noise_floor=noise_floor, calls_made=calls, results=results,
    )


@router.post("/{chat_id}/verified-draft", response_model=VerifiedDraft, dependencies=[Depends(llm_limit)])
def verified_draft(chat_id: UUID, payload: DraftRequest, user: User = Depends(current_user)):
    """High-stakes output. Every memory-derived claim is checked before it lands.

    The model drafts the text and labels how complete each of its own sentences sounds.
    The comparison against what the memory actually says happens **here, in Python** —
    asking a model whether it overstated something is the check that fails quietly, and
    this is the exact failure the project exists to prevent.
    """
    with pool.connection() as conn, conn.cursor() as cur:
        _assert_chat(cur, chat_id, user.id)
    vec = embed_query(payload.instruction)
    with pool.connection() as conn, conn.cursor() as cur:
        memories = retrieve(
            cur, str(user.id), str(chat_id), payload.instruction, vec=vec, destination="draft"
        )
    try:
        result = llm.verified_draft(payload.instruction, memories)
    except Exception as e:
        log.exception("verified draft failed")
        raise HTTPException(502, f"draft call failed: {llm.public_error(e)}") from e
    if result is None:
        raise HTTPException(502, "draft could not be parsed")

    claims: list[dict] = []
    for c in result.claims:
        sources = [
            memories[int(lbl[1:]) - 1]
            for lbl in c.memory_labels
            if lbl[1:].isdigit() and 0 < int(lbl[1:]) <= len(memories)
        ]
        asserted = None if c.asserted_as == "none" else AssertionStatus(c.asserted_as)

        # The comparison itself is a pure function in classify.py, so the P6 guarantee
        # can be tested across its whole truth table without a model call — including
        # the overstating case the model declines to produce on request.
        stale = any(s.get("is_stale") for s in sources)
        overstates, problem = check_claim(
            asserted, [AssertionStatus(s["status"]) for s in sources], stale
        )

        claims.append({
            "text": c.text,
            "asserted_as": asserted,
            "sources": sources,
            "overstates": overstates,
            "stale_source": stale,
            "problem": problem,
        })

    return {
        "instruction": payload.instruction,
        "draft": result.draft,
        "claims": claims,
        "needs_confirmation": any(c["overstates"] or c["stale_source"] for c in claims),
    }


@router.get("/{chat_id}/scope-report", response_model=ScopeReport)
def scope_report(chat_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor)):
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
    _assert_chat(cur, chat_id, user.id)
    live = "deleted_at is null and review_state in ('accepted','auto_accepted')"

    cur.execute(
        f"""select
              count(*) filter (where scope = 'persistent') as persistent,
              count(*) filter (where scope = 'session' and session_chat_id = %s) as session
            from memory_items where user_id = %s and {live}""",
        (chat_id, user.id),
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
        (user.id, chat_id),
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
           where m.session_ephemeral and mi.user_id = %s""",
        (user.id,),
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
def purge_ephemeral(chat_id: UUID, user: User = Depends(current_user), cur=Depends(db_cursor)):
    """Redact the text of off-the-record turns in this chat.

    Off the record governs *persistence*, not the current conversation: an ephemeral
    turn is still replayed as history within its own chat, because a model that
    cannot refer to what you said a moment ago is broken, not private. That text
    lives in `messages`, which is the transcript, not the memory store.

    This is the escape hatch for someone who wants it gone from the transcript too.
    Rows are redacted rather than deleted so the transcript still shows that
    something was said and withdrawn, instead of silently reshaping the history.
    """
    _assert_chat(cur, chat_id, user.id)
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


def _assert_chat(cur, chat_id: UUID, user_id: UUID) -> None:
    cur.execute(
        """select 1 from chats
            where id = %s and user_id = %s and deleted_at is null""",
        (chat_id, user_id),
    )
    if not cur.fetchone():
        raise HTTPException(404, "chat not found")
