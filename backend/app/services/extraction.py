"""Post-turn extraction pass.

Runs after the response is returned, so extraction latency (~9s on Flash) never sits
on the chat critical path.

**Scope is enforced here, not in the UI.** A turn marked session_ephemeral is skipped
entirely — no LLM call, no candidates, nothing written. That is the P3 guarantee and
the reason this check is the first thing in the function rather than a filter later on.
"""

from __future__ import annotations

import json
import logging

from app.db import pool
from app.models import AssertionStatus, ReviewState, Scope, Sensitivity, SourceType
from app.services import classify, llm
from app.services.policy import decide

log = logging.getLogger(__name__)

# Nearest live items compared per new item when looking for an update or contradiction.
RELATION_NEIGHBOURS = 3

# Exact per-user ranking, same shape as retrieval's MATERIALIZED CTE: restrict to the
# user by btree first, then rank, so other tenants' vectors can never crowd this out.
NEIGHBOUR_SQL = """
with mine as materialized (
  select mi.id, mi.content, mi.status, mi.embedding
  from memory_items mi
  join blocks b on b.id = mi.block_id
  where mi.user_id = %s
    and b.name = %s
    and mi.deleted_at is null
    and mi.review_state in ('accepted', 'auto_accepted')
    and mi.embedding is not null
    and mi.id::text <> all(%s::text[])
    and (mi.scope = 'persistent' or mi.session_chat_id = %s)
)
select id, content, status, embedding <=> %s::vector as distance
from mine
order by distance
limit %s
"""


def resolve_premises(
    item_ids: list[str | None],
    source_types: list[str],
    premise_labels: list[list[str]],
) -> tuple[list[tuple[str, str]], list[str]]:
    """Turn S1, S2... labels into (premise_id, inference_id) pairs.

    Labels number the *stated* candidates in list order, matching EXTRACTION_PROMPT.
    A label that names nothing, names a candidate that was not written (None id), or
    names the candidate itself is dropped and returned so the caller can log it.
    """
    by_label: dict[str, str | None] = {}
    n = 0
    for iid, st in zip(item_ids, source_types, strict=True):
        if st == "stated":
            n += 1
            by_label[f"S{n}"] = iid

    edges: list[tuple[str, str]] = []
    dropped: list[str] = []
    for target, labels in zip(item_ids, premise_labels, strict=True):
        for raw in labels:
            label = raw.strip().upper()
            src = by_label.get(label)
            if not src or not target or src == target:
                dropped.append(raw)
            elif (src, target) not in edges:
                edges.append((src, target))
    return edges, dropped


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
            status = AssertionStatus(c.status)
            evidence = c.evidence or c.content

            # P2 cross-check. Sensitivity can only move up; a status disagreement does
            # not overrule the model but does buy the item a human glance.
            sensitivity, bump_note = classify.raise_sensitivity(
                Sensitivity(c.sensitivity), evidence
            )
            status_note = classify.status_disagreement(status, evidence)

            d = decide(
                source_type=SourceType(c.source_type),
                sensitivity=sensitivity,
                # A contradicted status is not a confident one, whatever the model said.
                confidence=min(c.confidence, 0.5) if status_note else c.confidence,
                proposed_block=c.block,
                known_blocks=known,
                fallback_block=fallback,
                status=status,
            )
            extra = [n for n in (status_note, bump_note) if n]
            if extra:
                d.reason = "; ".join([*extra, d.reason])
                d.needs_review = True
                d.review_state = ReviewState.pending
            rows.append((c, d, sensitivity))

        # One embedding call for the whole turn's candidates rather than one per item.
        vectors = llm.embed([c.content for c, _, _ in rows]) if rows else []

        item_ids: list[str | None] = []
        with pool.connection() as conn, conn.cursor() as cur:
            # strict=True: a length mismatch here means candidates get dropped without
            # a trace. llm.embed() already guarantees this, and this is the backstop.
            for (c, d, sensitivity), vec in zip(rows, vectors, strict=True):
                cur.execute(
                    """
                    insert into memory_items (
                      user_id, block_id, content, evidence, source_type, status,
                      sensitivity, scope, confidence, source_message_id,
                      session_chat_id, review_state, needs_review, review_reason,
                      embedding, content_origin, abstracted
                    )
                    select %s, b.id, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           'model_worded', %s
                    from blocks b where b.user_id = %s and b.name = %s
                    returning id
                    """,
                    (
                        user_id, c.content, c.evidence, c.source_type, c.status,
                        sensitivity.value, d.scope.value, c.confidence, message_id,
                        chat_id if d.scope is Scope.session else None,
                        d.review_state.value, d.needs_review, d.reason, str(vec),
                        c.abstracted,
                        user_id, d.block_name,
                    ),
                )
                new = cur.fetchone()
                item_ids.append(str(new["id"]) if new else None)
                if new:
                    cur.execute(
                        """insert into audit_log (memory_item_id, action, actor, detail)
                           values (%s, %s, 'system', %s)""",
                        (
                            new["id"],
                            "auto_accepted" if not d.needs_review else "surfaced_for_review",
                            # json.dumps, not string surgery: the reason routinely contains
                            # apostrophes ("'x' isn't one of your blocks"), and the old
                            # repr-and-replace produced invalid JSON that made the whole
                            # insert — and so the whole extraction pass — fail.
                            json.dumps({"reason": d.reason}),
                        ),
                    )

            # F7: premises were inferred from stated items of this turn. Confirmed from
            # the start, because the extractor itself is asserting the dependency.
            edges, dropped = resolve_premises(
                item_ids, [c.source_type for c, _, _ in rows], [c.premises for c, _, _ in rows]
            )
            if dropped:
                log.warning("dropped unresolvable premise labels for %s: %s", message_id, dropped)
            for src, dst in edges:
                cur.execute(
                    """insert into memory_edges (from_item_id, to_item_id, relation, state, origin)
                       values (%s, %s, 'derived_from', 'confirmed', 'extraction')
                       on conflict do nothing""",
                    (src, dst),
                )

            # F4: propose, never apply. Compare against items from before this batch.
            batch = [i for i in item_ids if i]
            for (c, d, _), vec, iid in zip(rows, vectors, item_ids, strict=True):
                if not iid:
                    continue
                cur.execute(
                    NEIGHBOUR_SQL,
                    (user_id, d.block_name, batch, chat_id, str(vec), RELATION_NEIGHBOURS),
                )
                new_item = {"content": c.content, "status": c.status, "block_name": d.block_name}
                for old in cur.fetchall():
                    old_item = {"content": old["content"], "status": old["status"],
                                "block_name": d.block_name}
                    found = classify.propose_relation(new_item, old_item, old["distance"])
                    if found:
                        cur.execute(
                            """insert into memory_edges
                                 (from_item_id, to_item_id, relation, state, origin)
                               values (%s, %s, %s::edge_relation, 'proposed', 'heuristic')
                               on conflict do nothing""",
                            (old["id"], iid, found[0]),
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
