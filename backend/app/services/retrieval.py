"""Which memories are allowed to shape this response.

Two filters, both load-bearing:

1. **Scope.** A session-scoped item is visible only inside the chat that produced it.
   Enforced in SQL, so a bug in the UI cannot leak it into another conversation.
2. **Review state.** Only items the user accepted — or that were auto-accepted under
   the interruption budget — are eligible. A candidate still awaiting review has not
   been agreed to yet, so it must not influence anything.
"""

from __future__ import annotations

import logging

from app.config import settings
from app.services import gemini

log = logging.getLogger(__name__)

# Cosine distance, not similarity: 0 is identical, 2 is opposite. Anything past this
# is unrelated enough that injecting it adds noise and dilutes attribution.
MAX_DISTANCE = 0.65
TOP_K = 8

RETRIEVE_SQL = """
select mi.id, mi.content, mi.status, mi.scope, mi.sensitivity, mi.source_type,
       b.name as block_name,
       mi.embedding <=> %s::vector as distance,
       -- P6 decay: something the user was in the middle of months ago is not
       -- evidence that they still are. Only in_progress decays — a completed fact
       -- does not become less true with time.
       (mi.status = 'in_progress'
        and coalesce(mi.last_confirmed_at, mi.created_at)
            < now() - make_interval(days => %s)) as is_stale
from memory_items mi
left join blocks b on b.id = mi.block_id
where mi.user_id = %s
  and mi.deleted_at is null
  and mi.review_state in ('accepted', 'auto_accepted')
  and mi.embedding is not null
  and (mi.scope = 'persistent' or mi.session_chat_id = %s)
order by distance
limit %s
"""


def retrieve(
    cur, user_id: str, chat_id: str, query: str, exclude: set[str] | None = None
) -> list[dict]:
    try:
        vec = gemini.embed([query])[0]
    except Exception:
        # A failed embedding should cost the response its memory, not its existence.
        log.exception("embedding failed during retrieval; answering without memory")
        return []

    cur.execute(
        RETRIEVE_SQL, (str(vec), settings.stale_after_days, user_id, chat_id, TOP_K)
    )
    rows = [r for r in cur.fetchall() if r["distance"] <= MAX_DISTANCE]
    if exclude:
        rows = [r for r in rows if str(r["id"]) not in exclude]
    return rows
