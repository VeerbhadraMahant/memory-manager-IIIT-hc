"""Post-turn extraction pass.

Runs after the response is returned, so extraction latency (~9s on Flash) never sits
on the chat critical path.

**Scope is enforced here, not in the UI.** A turn marked session_ephemeral is skipped
entirely — no LLM call, no candidates, nothing written. That is the P3 guarantee and
the reason this check is the first thing in the function rather than a filter later on.
"""

from __future__ import annotations

import logging

from app.db import pool
from app.models import Scope, Sensitivity, SourceType
from app.services import llm
from app.services.policy import decide

log = logging.getLogger(__name__)


def run_extraction(message_id: str, chat_id: str, user_id: str) -> None:
    """Extract, classify, and file candidates for one user message."""
    try:
        with pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "select content, session_ephemeral, extraction_status from messages where id = %s",
                (message_id,),
            )
            msg = cur.fetchone()
            if not msg:
                return

            # P3: ephemeral turns never reach the extractor at all.
            if msg["session_ephemeral"]:
                cur.execute(
                    "update messages set extraction_status = 'skipped' where id = %s",
                    (message_id,),
                )
                conn.commit()
                log.info("extraction skipped (ephemeral) for %s", message_id)
                return

            cur.execute(
                "select name, is_fallback from blocks where user_id = %s order by restrictive_rank",
                (user_id,),
            )
            blocks = cur.fetchall()
            known = {b["name"] for b in blocks}
            fallback = next(b["name"] for b in blocks if b["is_fallback"])

        candidates = llm.extract_candidates(msg["content"], sorted(known))

        rows = []
        for c in candidates:
            # The schema gives back plain strings; policy reasons in enums so an
            # unrecognised value fails here rather than silently falling through a
            # comparison that is never true.
            d = decide(
                source_type=SourceType(c.source_type),
                sensitivity=Sensitivity(c.sensitivity),
                confidence=c.confidence,
                proposed_block=c.block,
                known_blocks=known,
                fallback_block=fallback,
            )
            rows.append((c, d))

        # One embedding call for the whole turn's candidates rather than one per item.
        vectors = llm.embed([c.content for c, _ in rows]) if rows else []

        with pool.connection() as conn, conn.cursor() as cur:
            # strict=True: a length mismatch here means candidates get dropped without
            # a trace. llm.embed() already guarantees this, and this is the backstop.
            for (c, d), vec in zip(rows, vectors, strict=True):
                cur.execute(
                    """
                    insert into memory_items (
                      user_id, block_id, content, evidence, source_type, status,
                      sensitivity, scope, confidence, source_message_id,
                      session_chat_id, review_state, needs_review, review_reason,
                      embedding
                    )
                    select %s, b.id, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                    from blocks b where b.user_id = %s and b.name = %s
                    returning id
                    """,
                    (
                        user_id, c.content, c.evidence, c.source_type, c.status,
                        c.sensitivity, d.scope.value, c.confidence, message_id,
                        chat_id if d.scope is Scope.session else None,
                        d.review_state.value, d.needs_review, d.reason, str(vec),
                        user_id, d.block_name,
                    ),
                )
                new = cur.fetchone()
                if new:
                    cur.execute(
                        """insert into audit_log (memory_item_id, action, actor, detail)
                           values (%s, %s, 'system', %s)""",
                        (
                            new["id"],
                            "auto_accepted" if not d.needs_review else "surfaced_for_review",
                            f'{{"reason": {d.reason!r}}}'.replace("'", '"'),
                        ),
                    )

            cur.execute(
                "update messages set extraction_status = 'done' where id = %s", (message_id,)
            )
            conn.commit()

        log.info("extracted %d candidates for %s", len(rows), message_id)

    except Exception as e:
        log.exception("extraction failed for %s", message_id)
        try:
            with pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    """update messages
                       set extraction_status = 'failed', extraction_error = %s
                       where id = %s""",
                    (f"{type(e).__name__}: {e}"[:500], message_id),
                )
                conn.commit()
        except Exception:
            log.exception("could not record extraction failure")
