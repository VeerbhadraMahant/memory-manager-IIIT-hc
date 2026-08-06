"""Apply SQL migrations in order, once each.

Deliberately not Alembic. The schema is known up front (SYSTEM_DESIGN.md §3) and
autogenerate/revision plumbing costs more hackathon hours than it saves. What we
actually need is "run each .sql file once, in order, transactionally" — that is
this file, and it is auditable at a glance.

    python backend/scripts/migrate.py           # apply pending
    python backend/scripts/migrate.py --status  # show what's applied
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"

TRACKING_TABLE = """
create table if not exists schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
)
"""


def _applied(conn: psycopg.Connection) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(TRACKING_TABLE)
        cur.execute("select filename from schema_migrations")
        return {row[0] for row in cur.fetchall()}


def main() -> int:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        print(f"no .sql files in {MIGRATIONS_DIR}")
        return 1

    with psycopg.connect(settings.database_url, connect_timeout=15) as conn:
        done = _applied(conn)
        conn.commit()

        if "--status" in sys.argv:
            for f in files:
                print(f"  {'applied' if f.name in done else 'PENDING'}  {f.name}")
            return 0

        pending = [f for f in files if f.name not in done]
        if not pending:
            print(f"up to date ({len(done)} applied)")
            return 0

        for f in pending:
            print(f"applying {f.name} ...", end=" ", flush=True)
            try:
                # Each migration is one transaction: a failure leaves no partial schema.
                with conn.transaction():
                    with conn.cursor() as cur:
                        cur.execute(f.read_text(encoding="utf-8"))
                        cur.execute(
                            "insert into schema_migrations (filename) values (%s)",
                            (f.name,),
                        )
                print("ok")
            except Exception as e:
                print("FAILED")
                print(f"\n  {type(e).__name__}: {e}")
                print("\n  Rolled back. Schema is unchanged by this file.")
                return 1

        print(f"\n{len(pending)} migration(s) applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
