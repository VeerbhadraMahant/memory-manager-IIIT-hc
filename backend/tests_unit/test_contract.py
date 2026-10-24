"""The phase 9 vocabulary lives in three places: SQL, models.py, api.ts. These checks
fail when one of them drifts, without needing a database to find out."""

from __future__ import annotations

import re
from pathlib import Path

from app.models import ContentOrigin, EdgeOrigin, EdgeState, FlowDestination

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "backend" / "migrations"
API_TS = ROOT / "frontend" / "lib" / "api.ts"


def _sql_enum(name: str) -> list[str]:
    sql = "\n".join(p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS.glob("*.sql")))
    m = re.search(rf"create type {name}\s+as enum \(([^)]*)\)", sql)
    assert m, f"enum {name} not found in migrations"
    return re.findall(r"'([^']+)'", m.group(1))


def _ts_union(name: str) -> list[str]:
    ts = API_TS.read_text(encoding="utf-8")
    m = re.search(rf"export type {name} =([^;]*);", ts)
    assert m, f"type {name} not found in api.ts"
    return re.findall(r'"([^"]+)"', m.group(1))


def test_enums_match_across_sql_python_and_typescript():
    for sql_name, py_enum, ts_name in [
        ("flow_destination", FlowDestination, "FlowDestination"),
        ("edge_state", EdgeState, "EdgeState"),
        ("edge_origin", EdgeOrigin, "EdgeOrigin"),
        ("content_origin", ContentOrigin, "ContentOrigin"),
    ]:
        py = [e.value for e in py_enum]
        assert _sql_enum(sql_name) == py, sql_name
        assert _ts_union(ts_name) == py, ts_name


def test_new_user_draft_defaults_match_migration_009():
    from app.services.users import DEFAULT_BLOCKS, DRAFT_DENIED_BLOCKS

    sql = (MIGRATIONS / "009_block_flow_rules.sql").read_text(encoding="utf-8")
    in_sql = set(re.findall(r"'(\w+)'", sql.split("where name in", 1)[1]))
    assert in_sql == DRAFT_DENIED_BLOCKS
    assert DRAFT_DENIED_BLOCKS <= {b[0] for b in DEFAULT_BLOCKS}
