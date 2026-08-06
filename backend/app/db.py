from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings

# Supabase sits across the network, so a pool matters more than it would locally —
# a fresh TLS handshake per request is ~100ms we would pay on every chat turn.
pool = ConnectionPool(
    conninfo=settings.database_url,
    min_size=1,
    max_size=8,
    open=False,
    kwargs={"row_factory": dict_row},
)


@contextmanager
def get_cursor(commit: bool = False) -> Iterator:
    """Cursor from the pool. Rows come back as dicts."""
    with pool.connection() as conn:
        with conn.cursor() as cur:
            yield cur
        if commit:
            conn.commit()


def db_cursor() -> Iterator:
    """FastAPI dependency — read-only by default; writes commit explicitly."""
    with pool.connection() as conn:
        with conn.cursor() as cur:
            yield cur
