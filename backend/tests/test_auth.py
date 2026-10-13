import time

import jwt

from tests.conftest import bearer, create_memory, make_user_token, seed_chat_and_message


def test_unauthenticated_rejected_when_required(client, auth_on):
    r = client.get("/chats")
    assert r.status_code == 401
    assert client.get("/healthz").status_code == 200  # probes stay public


def test_supabase_token_provisions_user_with_blocks(client, auth_on, db):
    tok, uid = make_user_token()
    me = client.get("/me", headers=bearer(tok)).json()
    assert me["id"] == uid and me["is_demo_user"] is False and me["name"] == "Test User"
    blocks = client.get("/memory/blocks", headers=bearer(tok)).json()
    assert len(blocks) == 9 and blocks[0]["is_fallback"]


def test_bad_tokens_rejected(client, auth_on):
    good, uid = make_user_token()
    expired, _ = make_user_token(exp=int(time.time()) - 10)
    wrong_aud, _ = make_user_token(aud="other")
    forged = jwt.encode({"sub": uid, "aud": "authenticated", "exp": int(time.time()) + 99}, "x" * 40, algorithm="HS256")
    none_alg = jwt.encode({"sub": uid, "aud": "authenticated"}, None, algorithm="none")
    for t in (expired, wrong_aud, forged, none_alg, "garbage"):
        assert client.get("/chats", headers=bearer(t)).status_code == 401, t
    assert client.get("/chats", headers=bearer(good)).status_code == 200


def test_users_are_isolated(client, auth_on):
    a, b = bearer(make_user_token()[0]), bearer(make_user_token()[0])
    chat, msg = seed_chat_and_message(client, a)
    item = create_memory(client, msg, a)
    assert client.get(f"/memory/items/{item['id']}", headers=b).status_code == 404
    assert client.get(f"/chats/{chat['id']}/messages", headers=b).status_code == 404
    assert client.delete(f"/memory/items/{item['id']}", headers=b).status_code == 404
    assert client.get("/memory/items", headers=b).json() == []
    # b cannot hang a memory off a's message
    _, msg_b = seed_chat_and_message(client, b)
    r = client.post("/memory/items", headers=b, json={
        "content": "x", "source_type": "stated", "status": "completed", "sensitivity": "low",
        "scope": "persistent", "confidence": 0.5, "source_message_id": msg["id"]})
    assert r.status_code == 422


def test_session_token_roundtrip(client, auth_on):
    from app.auth import issue_session_token
    from uuid import uuid4
    from app.db import pool
    from app.services.users import provision_user
    uid = uuid4()
    with pool.connection() as conn, conn.cursor() as cur:
        provision_user(cur, uid)
    tok = issue_session_token(uid)
    assert client.get("/me", headers=bearer(tok)).json()["id"] == str(uid)
    client.cookies.set("nam_session", tok)
    assert client.get("/me").json()["id"] == str(uid)


def test_google_endpoint_rejects_bad_credential(client):
    r = client.post("/auth/google", json={"credential": "x" * 40})
    assert r.status_code == 401


def test_export_and_delete_account(client, auth_on, db):
    tok, uid = make_user_token()
    h = bearer(tok)
    chat, msg = seed_chat_and_message(client, h)
    item = create_memory(client, msg, h)
    client.post(f"/memory/items/{item['id']}/subnodes", json={"content": "n"}, headers=h)

    dump = client.get("/me/export", headers=h).json()
    assert len(dump["memory_items"]) == 1 and len(dump["memory_subnodes"]) == 1
    assert "embedding" not in dump["memory_items"][0]

    assert client.delete("/me", headers=h).json() == {"status": "deleted"}
    for table in ("users", "chats", "memory_items", "memory_subnodes", "blocks"):
        col = "id" if table == "users" else "user_id"
        assert db.execute(f"select count(*) as n from {table} where {col} = %s", (uid,)).fetchone()["n"] == 0
    assert db.execute("select count(*) as n from audit_log where memory_item_id = %s", (item["id"],)).fetchone()["n"] == 0


def test_demo_account_cannot_be_deleted(client):
    assert client.delete("/me").status_code == 403


def test_rate_limit(client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "rate_limit_per_minute", 3)
    codes = [client.get("/chats").status_code for _ in range(5)]
    assert codes[:3] == [200] * 3 and codes[3] == 429
