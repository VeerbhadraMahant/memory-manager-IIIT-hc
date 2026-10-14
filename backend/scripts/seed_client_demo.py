"""Seed the demo user with a full, convincing set of chats and memories for client demo.

What this produces:
  * Wipes all existing chats and memories for the demo user (with --yes flag)
  * 5 realistic chat sessions spread across the last 3 weeks, each with a
    full back-and-forth transcript so the session list looks lived-in
  * 18 memory items spanning work, health, education, relationships, and
    finance blocks — a mix of sensitivities, statuses, and scopes
  * 2 session-scoped items (one hidden from a different chat, so the P3
    scope-report demo beats work out of the box)
  * 1 deliberately stale in-progress item (CHI paper) so the P6 decay
    indicator triggers immediately on load

Usage:
    python backend/scripts/seed_client_demo.py          # prompts before deleting
    python backend/scripts/seed_client_demo.py --yes    # no prompt, for CI / quick reset
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


# ---------------------------------------------------------------------------
# Chat sessions — each entry is (title, days_ago, [messages])
# messages are (role, content) tuples in order
# ---------------------------------------------------------------------------

SESSIONS: list[tuple[str, int, list[tuple[str, str]]]] = [
    # Session 1 (oldest, 21 days ago)
    (
        "Getting started",
        21,
        [
            ("user",
             "Hi — I'm Arjun, an HCI researcher at IIIT Hyderabad. "
             "I'm in the middle of writing a CHI paper with my colleague Priya "
             "on negotiated memory interfaces. Should wrap next month."),
            ("assistant",
             "Welcome, Arjun! That sounds like a fascinating project — "
             "negotiated memory interfaces is a rich design space. "
             "What stage is the paper at?"),
            ("user",
             "Still in the drafting phase. Priya is handling the related-work section "
             "while I'm drafting the system description. "
             "Separately, I've been learning Rust in my spare time — "
             "currently stuck on the borrow checker chapter. "
             "My sister Meera's wedding is also coming up in December, "
             "so there's a lot going on."),
            ("assistant",
             "Got it — CHI drafting, Rust borrow checker, and a December wedding. "
             "I'll remember all of that. "
             "Anything specific you'd like help thinking through today?"),
            ("user",
             "For context: I've been on 20 mg escitalopram since March and I run "
             "three mornings a week — just so you know that background."),
            ("assistant",
             "Understood. I'll keep the health context in mind and handle it with "
             "care. Let me know what you'd like to dive into."),
        ],
    ),

    # Session 2 (15 days ago)
    (
        "CHI paper — system description feedback",
        15,
        [
            ("user",
             "Can you read through this paragraph from my system description and "
             "tell me if the framing is clear? "
             "'Sigichai surfaces memory items to the user as first-class objects, "
             "allowing users to inspect, edit, and retract facts the system "
             "inferred about them, without interrupting the flow of conversation.'"),
            ("assistant",
             "The framing is clear and the key verbs — inspect, edit, retract — "
             "do real work. One suggestion: 'inferred' might undersell the system "
             "if it also stores *stated* facts. You could say 'derived or stated about them' "
             "to cover both source types. Does your taxonomy distinguish them?"),
            ("user",
             "Yes, we have stated vs. inferred as a source_type field. Good catch. "
             "I'll update it. Also — I finished the intro statistics course I was "
             "taking last semester, finally got around to submitting the final project."),
            ("assistant",
             "Nice work finishing the stats course! That's one thing off the plate. "
             "The revised sentence would read: '...facts the system derived or stated about them.' "
             "Want me to suggest edits to the rest of the paragraph?"),
            ("user",
             "Yes please, but keep the academic tone."),
            ("assistant",
             "Sure. Here's a tightened version:\n\n"
             "'Sigichai surfaces memory items as first-class objects, enabling users "
             "to inspect, edit, and retract facts the system has derived or recorded "
             "on their behalf — all without interrupting the conversational flow.'\n\n"
             "The 'on their behalf' grounds the agency claim without sounding legalistic."),
        ],
    ),

    # Session 3 (10 days ago)
    (
        "Rust — lifetimes deep dive",
        10,
        [
            ("user",
             "Okay I think I finally understand borrow checking. "
             "Can you give me a quiz on Rust lifetimes?"),
            ("assistant",
             "Sure! Here's question 1:\n\n"
             "```rust\nfn longest<'a>(x: &'a str, y: &'a str) -> &'a str {\n"
             "    if x.len() > y.len() { x } else { y }\n}\n```\n\n"
             "Why does this function need a lifetime annotation `'a`?"),
            ("user",
             "Because the return value borrows from one of the two inputs, "
             "and the compiler needs to know which lifetime the returned reference is "
             "tied to — so it picks the shorter of the two."),
            ("assistant",
             "Exactly right. The compiler takes the intersection of both lifetimes "
             "so the returned reference is valid for as long as *both* inputs live. "
             "Ready for question 2?"),
            ("user",
             "Yes. And just so you know — I've started a new Coursera course on "
             "machine learning to complement the stats I finished recently."),
            ("assistant",
             "I've noted the ML Coursera course. Here's question 2: What does "
             "the `'static` lifetime mean, and when would you actually use it?"),
            ("user",
             "It means the reference is valid for the entire duration of the program. "
             "You'd use it for string literals baked into the binary, or for data "
             "that you deliberately leak into a global."),
            ("assistant",
             "Spot on. String literals are the canonical example — they live in the "
             "binary's read-only data segment. You've clearly moved past the borrow "
             "checker chapter!"),
        ],
    ),

    # Session 4 (5 days ago)
    (
        "Wedding planning — Meera's Dec ceremony",
        5,
        [
            ("user",
             "Meera confirmed the wedding venue today — it's at Taj Falaknuma in Hyderabad, "
             "ceremony on December 14th. I need to give a speech and I have no idea where "
             "to start."),
            ("assistant",
             "Congratulations to Meera! Taj Falaknuma is a stunning venue. "
             "For the speech: a classic structure that works for siblings is "
             "(1) a childhood memory that reveals her character, "
             "(2) what she means to you now, and "
             "(3) a toast to the couple. "
             "Do you have a funny or touching story from when you were kids?"),
            ("user",
             "She once dragged me to every bookshop in Hyderabad looking for a specific "
             "Ruskin Bond novel when we were like 10. We found it at the fifth shop. "
             "That kind of sums her up — relentless when she wants something."),
            ("assistant",
             "That story is perfect — it's specific, warm, and tells us exactly who "
             "Meera is. You could open with it and then connect that same quality to "
             "how she'll be as a partner. Want me to draft a rough structure?"),
            ("user",
             "Please do. Keep it under two minutes when read aloud — about 250 words."),
            ("assistant",
             "Here's a ~250-word draft:\n\n"
             "---\n"
             "Meera has always known exactly what she wants. When we were ten, "
             "she dragged me to five bookshops across Hyderabad in search of a "
             "single Ruskin Bond novel. Not one bookshop. Five. "
             "She found it at the last one, and she looked entirely unsurprised.\n\n"
             "That quality — that quiet certainty — is what I've watched her bring "
             "to every important thing in her life since. Her career, her friendships, "
             "and now, today, the person she has chosen to build a life with.\n\n"
             "[Partner's name], I don't know if you realise yet that she will drag you "
             "to five bookshops too. But I promise you: it'll always be worth it.\n\n"
             "To Meera and [Partner] — may you always find what you're looking for, "
             "together.\n"
             "---\n\n"
             "Fill in the partner's name and adjust the middle paragraph as needed."),
        ],
    ),

    # Session 5 (1 day ago)
    (
        "Quick check-in",
        1,
        [
            ("user",
             "Hey — quick update. My doctor increased escitalopram to 30 mg from Monday. "
             "Also the CHI paper submission deadline got pushed to February, which is both "
             "a relief and a source of more anxiety somehow."),
            ("assistant",
             "Thanks for the update — I've noted the dosage change to 30 mg. "
             "Mixed feelings about a deadline extension make complete sense: "
             "relief because there's more time, anxiety because the target moved. "
             "Is there a specific part of the paper you want to nail before February?"),
            ("user",
             "The evaluation section. We haven't run the full user study yet."),
            ("assistant",
             "That's the highest-stakes section to leave late — user studies rarely "
             "compress well. Do you have a participant pool already, or is recruiting "
             "still an open question?"),
            ("user",
             "We have 8 confirmed, need 12 minimum for statistical power. "
             "Priya is handling recruitment."),
            ("assistant",
             "Eight confirmed with Priya recruiting for 12 is a reasonable position "
             "at 6 months out. The main risk is dropout — it's worth having 15 "
             "scheduled so you can lose a few and still hit 12. "
             "Want me to help draft a participant-reminder script?"),
        ],
    ),
]


# ---------------------------------------------------------------------------
# Memory items
# (content, block, source_type, status, sensitivity, confidence,
#  review_state, days_ago, scope, session_index_or_None)
# ---------------------------------------------------------------------------
# session_index refers to SESSIONS list above; None -> persistent

MEMORIES: list[tuple] = [
    # Work
    (
        "Writing a CHI paper with Priya on negotiated memory interfaces",
        "work", "stated", "in_progress", "low", 0.95, "accepted",
        40,   # stale: 40 days > 14-day threshold
        "persistent", None,
    ),
    (
        "CHI paper submission deadline extended to February",
        "work", "stated", "in_progress", "low", 0.97, "accepted",
        1, "persistent", None,
    ),
    (
        "Works as an HCI researcher at IIIT Hyderabad",
        "work", "stated", "in_progress", "low", 0.99, "auto_accepted",
        21, "persistent", None,
    ),
    (
        "Prefers written feedback over verbal during paper reviews",
        "work", "inferred", "in_progress", "low", 0.72, "accepted",
        15, "persistent", None,
    ),
    (
        "Collaborates regularly with colleague Priya on research projects",
        "work", "stated", "in_progress", "low", 0.88, "auto_accepted",
        21, "persistent", None,
    ),
    (
        "Needs 12 participants for CHI user study, has 8 confirmed so far",
        "work", "stated", "in_progress", "low", 0.91, "accepted",
        1, "persistent", None,
    ),

    # Health
    (
        "On 30 mg escitalopram since this week (previously 20 mg since March)",
        "health", "stated", "in_progress", "special_category", 0.97, "accepted",
        1, "persistent", None,
    ),
    (
        "Runs three mornings a week",
        "health", "stated", "in_progress", "high", 0.80, "accepted",
        21, "persistent", None,
    ),

    # Education
    (
        "Completed an introductory statistics course (final project submitted)",
        "education", "stated", "completed", "medium", 0.96, "auto_accepted",
        15, "persistent", None,
    ),
    (
        "Learning Rust; reached and understood the lifetimes chapter",
        "education", "stated", "in_progress", "medium", 0.93, "accepted",
        10, "persistent", None,
    ),
    (
        "Started a Coursera machine learning course alongside Rust",
        "education", "stated", "in_progress", "medium", 0.89, "auto_accepted",
        10, "persistent", None,
    ),

    # Relationships
    (
        "Sister Meera's wedding is at Taj Falaknuma, Hyderabad on December 14th",
        "relationships", "stated", "planned", "high", 0.98, "accepted",
        5, "persistent", None,
    ),
    (
        "Arjun is giving a speech at Meera's wedding — draft under 250 words",
        "relationships", "stated", "planned", "high", 0.87, "accepted",
        5, "persistent", None,
    ),
    (
        "Meera and Arjun share a childhood memory of searching five bookshops for a Ruskin Bond novel",
        "relationships", "stated", "in_progress", "high", 0.76, "accepted",
        5, "persistent", None,
    ),

    # Session-scoped items (illustrate P3 scope isolation)
    # These two are scoped to session index 3 (wedding planning chat).
    (
        "Speech draft for Meera's wedding is approximately 250 words",
        "relationships", "inferred", "in_progress", "high", 0.70, "auto_accepted",
        5, "session", 3,
    ),
    (
        "Partner name is a placeholder in the wedding speech draft",
        "relationships", "inferred", "in_progress", "high", 0.65, "accepted",
        5, "session", 3,
    ),

    # Pending review items (show up in the review queue)
    (
        "Arjun may be experiencing increased anxiety related to the deadline shift",
        "health", "inferred", "in_progress", "high", 0.61, "pending",
        1, "persistent", None,
    ),
    (
        "Arjun prefers async written communication over synchronous meetings",
        "work", "inferred", "in_progress", "low", 0.68, "pending",
        15, "persistent", None,
    ),
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

            # Delete order: audit_log and attributions first (no FK restriction),
            # then memory_items (has FK to messages), then chats (cascades messages).
            cur.execute(
                "delete from audit_log where memory_item_id in "
                "(select id from memory_items where user_id = %s)", (user,)
            )
            try:
                cur.execute(
                    "delete from attributions where memory_item_id in "
                    "(select id from memory_items where user_id = %s)", (user,)
                )
            except Exception:
                pass  # attributions table may not exist on older schema versions
            cur.execute("delete from memory_items where user_id = %s", (user,))
            cur.execute("delete from chats where user_id = %s", (user,))

            # Look up blocks
            cur.execute("select id, name from blocks where user_id = %s", (user,))
            blocks = {b["name"]: b["id"] for b in cur.fetchall()}

            needed_blocks = {m[1] for m in MEMORIES}
            missing = needed_blocks - blocks.keys()
            if missing:
                print(f"Blocks missing from the database: {sorted(missing)}", file=sys.stderr)
                print("Run backend/scripts/migrate.py first.", file=sys.stderr)
                return 2

            # Create chats and messages
            chat_ids: list[str] = []
            anchor_message_ids: list[str] = []  # last user msg per session

            for title, days_ago, transcript in SESSIONS:
                chat_created = NOW - timedelta(days=days_ago)
                cur.execute(
                    "insert into chats (user_id, title, created_at) "
                    "values (%s, %s, %s) returning id",
                    (user, title, chat_created),
                )
                chat_id = cur.fetchone()["id"]
                chat_ids.append(str(chat_id))

                last_user_msg_id = None
                for i, (role, content) in enumerate(transcript):
                    msg_ts = chat_created + timedelta(minutes=i * 2)
                    cur.execute(
                        """insert into messages
                               (chat_id, role, content, extraction_status, created_at)
                           values (%s, %s, %s, 'done', %s) returning id""",
                        (chat_id, role, content, msg_ts),
                    )
                    msg_id = cur.fetchone()["id"]
                    if role == "user":
                        last_user_msg_id = str(msg_id)

                anchor_message_ids.append(last_user_msg_id)

            # Embed all memory content in a single API call
            print(f"Embedding {len(MEMORIES)} memory items (1 API call)...", flush=True)
            vectors = llm.embed([m[0] for m in MEMORIES])

            # Insert memory items
            for i, (row, vec) in enumerate(zip(MEMORIES, vectors, strict=True)):
                (content, block, source, status, sens, conf,
                 review, days, scope, session_idx) = row

                anchor_session = session_idx if session_idx is not None else 0
                source_msg_id = anchor_message_ids[anchor_session]

                session_chat_id = (
                    chat_ids[session_idx]
                    if scope == "session" and session_idx is not None
                    else None
                )

                needs_review_flag = review == "pending"
                created_ts = NOW - timedelta(days=days)

                cur.execute(
                    """
                    insert into memory_items (
                      user_id, block_id, content, evidence, source_type, status,
                      sensitivity, scope, confidence, source_message_id,
                      session_chat_id, review_state, needs_review, review_reason,
                      embedding, created_at, last_confirmed_at
                    ) values (
                      %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                      %s, %s, %s
                    )
                    """,
                    (
                        user,
                        blocks[block],
                        content,
                        content,
                        source,
                        status,
                        sens,
                        scope,
                        conf,
                        source_msg_id,
                        session_chat_id,
                        review,
                        needs_review_flag,
                        "seeded client demo",
                        str(vec),
                        created_ts,
                        created_ts,
                    ),
                )

        conn.commit()

    stale_count = sum(1 for m in MEMORIES if m[7] > settings.stale_after_days)
    session_count = sum(1 for m in MEMORIES if m[8] == "session")
    pending_count = sum(1 for m in MEMORIES if m[6] == "pending")

    print(
        f"\n Seeded {len(SESSIONS)} chat sessions and {len(MEMORIES)} memory items.\n"
        f"  Stale items (>{settings.stale_after_days}d unconfirmed): {stale_count}\n"
        f"  Session-scoped items:                              {session_count}\n"
        f"  Pending review items:                              {pending_count}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
