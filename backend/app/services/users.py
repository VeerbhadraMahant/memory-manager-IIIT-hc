"""User provisioning.

Migration 005 noted that seeding blocks for a newly created user "belongs with the auth
work". This is that work: the first time an identity is seen, the user row and the full
block taxonomy are created together in one transaction, so a user can never exist with
no fallback block (which would make extraction fail at `next(...)` on the first turn).
"""

from __future__ import annotations

import logging
from uuid import UUID

log = logging.getLogger(__name__)

# (name, default_sensitivity, restrictive_rank, is_fallback) — the end state of
# migrations 002 + 005. tests/test_users.py asserts this equals what the migrations
# produce for the demo user, so the two cannot drift.
DEFAULT_BLOCKS: tuple[tuple[str, str, int, bool], ...] = (
    ("unclassified", "high", 0, True),
    ("health", "special_category", 10, False),
    ("identity", "high", 20, False),
    ("finance", "high", 30, False),
    ("relationships", "high", 40, False),
    ("location", "high", 50, False),
    ("education", "medium", 60, False),
    ("work", "low", 70, False),
    ("preferences", "low", 80, False),
)


def seed_blocks(cur, user_id: UUID) -> None:
    for name, sens, rank, fallback in DEFAULT_BLOCKS:
        cur.execute(
            """insert into blocks (user_id, name, default_sensitivity, restrictive_rank, is_fallback)
               values (%s, %s, %s, %s, %s) on conflict (user_id, name) do nothing""",
            (user_id, name, sens, rank, fallback),
        )


def provision_user(
    cur,
    user_id: UUID,
    *,
    email: str | None = None,
    name: str | None = None,
    avatar_url: str | None = None,
    google_sub: str | None = None,
) -> dict:
    """Create the user (and blocks) if new; refresh profile fields if known. Idempotent."""
    cur.execute("select * from users where id = %s", (user_id,))
    row = cur.fetchone()
    if row:
        # Refresh display fields only — never email/google_sub identity keys, which
        # would let a later token silently re-point an existing account.
        if (name and name != row["name"]) or (avatar_url and avatar_url != row["avatar_url"]):
            cur.execute(
                "update users set name = coalesce(%s, name), avatar_url = coalesce(%s, avatar_url) where id = %s returning *",
                (name, avatar_url, user_id),
            )
            row = cur.fetchone()
        return row

    # The email column is unique. If another account already holds it (e.g. the same
    # person via a different provider), store this one without an email rather than
    # failing sign-in or, worse, merging two identities on an unverified match.
    if email:
        cur.execute("select 1 from users where email = %s", (email,))
        if cur.fetchone():
            email = None
    cur.execute(
        """insert into users (id, handle, email, name, avatar_url, google_sub)
           values (%s, %s, %s, %s, %s, %s) returning *""",
        (user_id, f"user-{str(user_id)[:8]}-{str(user_id)[-4:]}", email, name, avatar_url, google_sub),
    )
    row = cur.fetchone()
    seed_blocks(cur, user_id)
    log.info("provisioned user %s", user_id)
    return row
