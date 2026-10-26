from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings

# Supabase sits across the network, so a pool matters more than it would locally —
# a fresh TLS handshake per request is ~100ms we would pay on every chat turn.
#
# statement_timeout bounds a runaway query instead of letting it hold a pooled
# connection (and a worker thread) indefinitely.
_kwargs: dict = {
    "row_factory": dict_row,
    "options": f"-c statement_timeout={settings.db_statement_timeout_ms}",
}
if settings.db_disable_prepared_statements:
    # Required behind PgBouncer / Supabase's transaction pooler (port 6543).
    _kwargs["prepare_threshold"] = None

pool = ConnectionPool(
    conninfo=settings.dsn,
    min_size=settings.db_pool_min,
    max_size=settings.db_pool_max,
    timeout=settings.db_pool_timeout_s,
    # Recycle so a connection silently dropped by a pooler or NAT is replaced rather
    # than handed out dead.
    max_lifetime=1800,
    max_idle=300,
    check=ConnectionPool.check_connection,
    open=False,
    kwargs=_kwargs,
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
    """FastAPI dependency. The pooled connection commits on a clean exit and rolls back
    on an exception, so a handler that raises HTTPException halfway never leaves a
    partial write behind.

    Routes must declare it as `Depends(db_cursor, scope="function")`. With the default
    request scope FastAPI runs this exit code AFTER the response is sent, so the client
    can be told a delete succeeded before it is committed (or when the commit fails).

    Do not hold this across an LLM call on a hot path — see `get_cursor` and the turn
    handler, which take short-lived connections around the network calls instead.
    """
    with pool.connection() as conn:
        with conn.cursor() as cur:
            yield cur
