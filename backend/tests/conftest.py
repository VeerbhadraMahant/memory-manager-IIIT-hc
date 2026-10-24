"""Test harness: real Postgres + pgvector, mocked LLM.

Needs a database. Point TEST_DATABASE_URL at an empty, disposable one (CI provides a
pgvector service container; locally `docker compose up db`). Tests TRUNCATE tables, so
never aim this at a database you care about — the fixture refuses anything whose name
does not contain "test" or "nam" unless ALLOW_DESTRUCTIVE_TESTS=1.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TEST_DB = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not TEST_DB:
    pytest.skip("set TEST_DATABASE_URL to run the backend tests", allow_module_level=True)

# Must be set before `app` is imported: Settings() reads the environment at import.
os.environ["DATABASE_URL"] = TEST_DB
os.environ["ENVIRONMENT"] = "test"
os.environ["LLM_API_KEY"] = "sk-or-" "v1-testkeytestkeytestkey1234"
os.environ["GROQ_API_KEY"] = "gs" "k_testtesttesttesttest1234"
os.environ["SESSION_SECRET"] = "unit-test-session-secret-0123456789abcdef"
os.environ["GOOGLE_CLIENT_ID"] = "test-client.apps.googleusercontent.com"
SUPABASE_SECRET = "unit-test-supabase-jwt-secret-0123456789"
os.environ["SUPABASE_JWT_SECRET"] = SUPABASE_SECRET
os.environ["RATE_LIMIT_LLM_PER_MINUTE"] = "1000"
os.environ["RATE_LIMIT_PER_MINUTE"] = "100000"
os.environ.pop("AUTH_REQUIRED", None)

import psycopg  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DIM = 768


def fake_vector(text: str) -> list[float]:
    """Deterministic unit vector. Identical text -> identical vector (distance 0);
    different text -> effectively orthogonal (distance ~1, beyond MAX_DISTANCE)."""
    seed = hashlib.sha256(text.lower().strip().encode()).digest()
    raw = [((seed[i % 32] + i * 7) % 255) / 255.0 - 0.5 for i in range(DIM)]
    # perturb with a text-dependent pattern so different texts decorrelate
    h = int.from_bytes(seed[:8], "big")
    raw = [x if ((h >> (i % 61)) & 1) else -x for i, x in enumerate(raw)]
    n = sum(x * x for x in raw) ** 0.5
    return [x / n for x in raw]


@pytest.fixture(scope="session", autouse=True)
def _database():
    name = TEST_DB.rsplit("/", 1)[-1].split("?")[0]
    if not any(k in name for k in ("test", "nam")) and os.environ.get("ALLOW_DESTRUCTIVE_TESTS") != "1":
        pytest.exit(f"refusing to run destructive tests against database {name!r}", returncode=2)
    from scripts import migrate  # noqa: PLC0415

    assert migrate.main.__module__  # import check
    sys.argv = ["migrate.py"]
    assert migrate.main() == 0
    yield


@pytest.fixture()
def db():
    with psycopg.connect(TEST_DB, autocommit=True, row_factory=psycopg.rows.dict_row) as conn:
        yield conn


@pytest.fixture(autouse=True)
def _clean(db):
    db.execute(
        "truncate attributions, memory_edges, memory_subnodes, audit_log, memory_items, messages, chats"
        " restart identity cascade"
    )
    # Keep the demo user and its blocks; drop everything else (and reset privacy flags).
    db.execute("delete from blocks where user_id <> '00000000-0000-0000-0000-000000000001'")
    db.execute("delete from users where id <> '00000000-0000-0000-0000-000000000001'")
    # Flow rules too, back to migration 009's defaults: a test that denies a destination
    # on the demo user's block must not leak that rule into the next test.
    from app.services.users import DRAFT_DENIED_BLOCKS  # noqa: PLC0415

    db.execute(
        """update blocks set private = false,
             denied_destinations = case when name = any(%s) then '{draft}'::flow_destination[]
                                        else '{}'::flow_destination[] end""",
        (sorted(DRAFT_DENIED_BLOCKS),),
    )
    from app import auth, ratelimit  # noqa: PLC0415

    auth._known.clear()
    ratelimit.reset()
    yield


@pytest.fixture()
def llm_calls(monkeypatch):
    """Replace every network call in app.services.llm. Returns a recorder."""
    from app.services import llm  # noqa: PLC0415

    class Rec:
        embeds: list[str] = []
        chats: list[tuple[list, list]] = []
        extract_result: list = []
        fail_chat = False

    rec = Rec()
    rec.embeds, rec.chats, rec.extract_result = [], [], []

    def embed(texts):
        rec.embeds.extend(texts)
        return [fake_vector(t) for t in texts]

    def chat_response(history, memory_items, provider=None):
        if rec.fail_chat:
            raise RuntimeError("boom sk-or-" "v1-testkeytestkeytestkey1234")
        rec.chats.append((history, memory_items))
        return "ok reply", "openrouter", "test-model", ""

    monkeypatch.setattr(llm, "embed", embed)
    monkeypatch.setattr(llm, "chat_response", chat_response)
    monkeypatch.setattr(llm, "extract_candidates", lambda turn, blocks: list(rec.extract_result))
    monkeypatch.setattr(llm, "summarize_item", lambda *a, **k: None)
    return rec


@pytest.fixture(scope="session")
def _app_client():
    # One lifespan for the whole run: psycopg pools cannot be reopened once closed.
    from app.main import app  # noqa: PLC0415

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def client(_app_client, llm_calls):
    _app_client.cookies.clear()
    return _app_client


def make_user_token(sub: str | None = None, **claims) -> tuple[str, str]:
    """A Supabase-style HS256 access token. Returns (token, user_id)."""
    import time  # noqa: PLC0415

    import jwt  # noqa: PLC0415

    uid = sub or str(uuid4())
    payload = {
        "sub": uid, "aud": "authenticated", "exp": int(time.time()) + 3600,
        "email": f"{uid[:8]}@example.com", "user_metadata": {"full_name": "Test User"},
        **claims,
    }
    return jwt.encode(payload, SUPABASE_SECRET, algorithm="HS256"), uid


@pytest.fixture()
def auth_on(monkeypatch):
    from app.config import settings  # noqa: PLC0415

    monkeypatch.setattr(settings, "auth_required", True)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def seed_chat_and_message(client, headers=None, text="I am writing a paper"):
    chat = client.post("/chats", json={"title": "t"}, headers=headers or {}).json()
    msg = client.post(f"/chats/{chat['id']}/messages", json={"content": text}, headers=headers or {}).json()
    return chat, msg


def create_memory(client, msg, headers=None, **over):
    body = {
        "content": "Writing a CHI paper", "source_type": "stated", "status": "in_progress",
        "sensitivity": "low", "scope": "persistent", "confidence": 0.9,
        "source_message_id": msg["id"], "block_name": "work",
        "review_state": "accepted", **over,
    }
    r = client.post("/memory/items", json=body, headers=headers or {})
    assert r.status_code == 201, r.text
    return r.json()
