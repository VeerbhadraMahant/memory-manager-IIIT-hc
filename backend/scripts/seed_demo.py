"""Reset the demo user to a clean, presentable starting state.

Why this exists: forty-five chats titled `P0 smoke`, `P2/P6 smoke` and
`Session 41` were on screen in the session switcher. Test fixtures in the demo
UI cost credibility for no benefit, and there is no way to clear them from
inside the app — deleting a chat is not a memory operation and does not belong
in `useMemoryActions()`.

What it produces, per the `MVP.md` pre-demo checklist:

  * every existing chat and memory item for the demo user, gone
  * one chat ("Getting started") holding the seed messages, so principle 7 holds
    — every seeded memory still traces to a real source message
  * a small persistent store across the real blocks (work / health / learning /
    family), and
  * **one stale in-progress item** — the CHI paper, last confirmed 40 days ago,
    past the 14-day threshold. That is beat 4 of the demo script, and it cannot
    be demonstrated on a store where everything was created this morning.

Embeddings are real, not zeros: a zero vector has no meaningful cosine distance
and pgvector would return it in arbitrary order, so retrieval would look broken
in exactly the beat that is supposed to prove it works. One embed call covers
every seeded item.

    python backend/scripts/seed_demo.py            # prompts before deleting
    python backend/scripts/seed_demo.py --yes      # no prompt
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402
from app.services import llm  # noqa: E402

NOW = datetime.now(timezone.utc)

# (content, block, source_type, status, sensitivity, confidence, review_state,
#  last_confirmed_days_ago)
#
# Scope is persistent for all of these on purpose: the session-only claim is
# proven live in beat 3, and pre-seeding a session item would prove nothing.
SEED = [
    (
        "Writing a CHI paper with Priya on negotiated memory interfaces",
        "work", "stated", "in_progress", "low", 0.94, "accepted",
        # The stale one. 40 days > the 14-day threshold, so it renders with the
        # stale treatment and "still true?" the moment the app loads.
        40,
    ),
    (
        "Works as an HCI researcher",
        "work", "stated", "in_progress", "low", 0.91, "auto_accepted", 3,
    ),
    (
        "Prefers written summaries over meetings",
        "work", "inferred", "in_progress", "low", 0.68, "accepted", 5,
    ),
    (
        "Learning Rust, currently on the borrow checker chapter",
        "education", "stated", "in_progress", "medium", 0.88, "auto_accepted", 2,
    ),
    (
        "Took an intro statistics course last year",
        "education", "stated", "completed", "medium", 0.9, "accepted", 30,
    ),
    (
        "Sister Meera is getting married in December",
        "relationships", "stated", "planned", "high", 0.87, "accepted", 6,
    ),
    (
        "Has been on 20mg escitalopram since March",
        "health", "stated", "in_progress", "special_category", 0.93, "accepted", 4,
    ),
    (
        "Runs three mornings a week",
        "health", "stated", "in_progress", "high", 0.72, "accepted", 9,
    ),
]

# The transcript the seeded memories come from. Principle 7: no orphaned facts,
# so these are real rows in `messages` rather than a null source id.
TRANSCRIPT = [
    ("user", "I'm an HCI researcher — writing a CHI paper with Priya on negotiated "
             "memory interfaces at the moment. Should wrap next month."),
    ("assistant", "Noted. What stage is the paper at?"),
    ("user", "Drafting still. Separately I've been learning Rust, stuck on the borrow "
             "checker. And my sister Meera's wedding is in December."),
    ("assistant", "Got it."),
    ("user", "For context, I've been on 20mg escitalopram since March, and I run three "
             "mornings a week."),
    ("assistant", "Understood — that stays in your health block."),
]


def confirm(cur) -> bool:
    cur.execute(
        "select count(*) as n from chats where user_id = %s", (str(settings.demo_user_id),)
    )
    chats = cur.fetchone()["n"]
    cur.execute(
        "select count(*) as n from memory_items where user_id = %s",
        (str(settings.demo_user_id),),
    )
    items = cur.fetchone()["n"]
    print(f"About to delete {chats} chats and {items} memory items for the demo user.")
    return input("Type 'reset' to continue: ").strip() == "reset"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    user = str(settings.demo_user_id)

    with psycopg.connect(settings.database_url, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            if not args.yes and not confirm(cur):
                print("aborted.")
                return 1

            # memory_items.source_message_id is `on delete restrict`, so the items
            # go before the messages that hold them up. audit_log has no FK by
            # design, and is cleared explicitly rather than orphaned.
            cur.execute("delete from audit_log where memory_item_id in "
                        "(select id from memory_items where user_id = %s)", (user,))
            cur.execute("delete from memory_items where user_id = %s", (user,))
            cur.execute("delete from chats where user_id = %s", (user,))

            cur.execute(
                "insert into chats (user_id, title) values (%s, %s) returning id",
                (user, "Getting started"),
            )
            chat_id = cur.fetchone()["id"]

            message_ids = []
            for i, (role, content) in enumerate(TRANSCRIPT):
                cur.execute(
                    """insert into messages (chat_id, role, content, created_at)
                       values (%s, %s, %s, %s) returning id""",
                    (chat_id, role, content, NOW - timedelta(days=45, minutes=-i)),
                )
                message_ids.append(cur.fetchone()["id"])

            cur.execute("select id, name from blocks where user_id = %s", (user,))
            blocks = {b["name"]: b["id"] for b in cur.fetchall()}
            missing = {s[1] for s in SEED} - blocks.keys()
            if missing:
                print(f"blocks missing from the database: {sorted(missing)}", file=sys.stderr)
                print("run backend/scripts/migrate.py first.", file=sys.stderr)
                return 2

            vectors = llm.embed([s[0] for s in SEED])

            user_turns = [m for m, (role, _) in zip(message_ids, TRANSCRIPT) if role == "user"]
            for i, (row, vec) in enumerate(zip(SEED, vectors, strict=True)):
                content, block, source, status, sens, conf, review, days = row
                cur.execute(
                    """
                    insert into memory_items (
                      user_id, block_id, content, evidence, source_type, status,
                      sensitivity, scope, confidence, source_message_id,
                      review_state, needs_review, review_reason, embedding,
                      created_at, last_confirmed_at
                    ) values (
                      %s, %s, %s, %s, %s, %s, %s, 'persistent', %s, %s, %s, false, %s,
                      %s, %s, %s
                    )
                    """,
                    (
                        user, blocks[block], content, content, source, status, sens,
                        conf, user_turns[i % len(user_turns)], review,
                        "seeded demo memory",
                        str(vec),
                        NOW - timedelta(days=days),
                        NOW - timedelta(days=days),
                    ),
                )

        conn.commit()

    print(f"Seeded {len(SEED)} memories in one chat. "
          "One in-progress item is deliberately stale (CHI paper, 40 days).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
