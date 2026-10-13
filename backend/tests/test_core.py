from tests.conftest import bearer, create_memory, make_user_token, seed_chat_and_message

DEMO = "00000000-0000-0000-0000-000000000001"


def test_health_and_probes(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ready"}
    h = client.get("/health").json()
    assert h["pgvector"] and h["embedding_dim"] == 768
    r = client.get("/healthz")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-request-id"]


def test_demo_user_when_auth_not_required(client):
    me = client.get("/me").json()
    assert me["id"] == DEMO and me["is_demo_user"] is True


def test_memory_roundtrip_and_ownership_checks(client):
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg)
    assert client.get(f"/memory/items/{item['id']}").json()["content"] == "Writing a CHI paper"

    # source message that doesn't exist / isn't ours is a 422, not a foreign-key 500
    r = client.post("/memory/items", json={
        "content": "x", "source_type": "stated", "status": "completed", "sensitivity": "low",
        "scope": "persistent", "confidence": 0.5,
        "source_message_id": "11111111-1111-1111-1111-111111111111",
    })
    assert r.status_code == 422


def test_delete_item_cascades_and_flags(client, db):
    chat, msg = seed_chat_and_message(client)
    root = create_memory(client, msg, content="root fact")
    only_child = create_memory(client, msg, content="derived only from root")
    shared_child = create_memory(client, msg, content="derived from root and other")
    other = create_memory(client, msg, content="other source")
    for frm, to in [(root, only_child), (root, shared_child), (other, shared_child)]:
        db.execute(
            "insert into memory_edges (from_item_id, to_item_id, relation) values (%s,%s,'derived_from')",
            (frm["id"], to["id"]),
        )
    db.execute("insert into attributions (message_id, memory_item_id) values (%s,%s)", (msg["id"], root["id"]))

    preview = client.get(f"/memory/items/{root['id']}/graph").json()["cascade"]
    r = client.delete(f"/memory/items/{root['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cascade_delete"] == preview["cascade_delete"] == [only_child["id"]]
    assert body["flag_for_review"] == [shared_child["id"]]
    assert body["attribution_count"] == 1

    live = {i["id"] for i in client.get("/memory/items").json()}
    assert root["id"] not in live and only_child["id"] not in live
    assert shared_child["id"] in live and other["id"] in live
    flagged = client.get(f"/memory/items/{shared_child['id']}").json()
    assert flagged["needs_review"] is True and "deleted" in flagged["review_reason"]
    actions = {r["action"] for r in db.execute("select action from audit_log").fetchall()}
    assert {"deleted", "deleted_by_cascade", "flagged_for_review"} <= actions
    assert client.delete(f"/memory/items/{root['id']}").status_code == 404


def test_chat_turn_retrieves_memory_and_writes_attribution(client, llm_calls, db):
    chat, msg = seed_chat_and_message(client)
    create_memory(client, msg, content="Writing a CHI paper")
    r = client.post(f"/chats/{chat['id']}/message", json={"content": "Writing a CHI paper"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["content"] for m in body["used_memories"]] == ["Writing a CHI paper"]
    assert body["retrieval"]["injected_count"] == 1
    assert db.execute("select count(*) as n from attributions").fetchone()["n"] == 1


def test_private_block_never_reaches_prompt(client, llm_calls):
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content="Takes 20mg of something", block_name="health",
                         sensitivity="special_category")
    assert client.patch("/memory/blocks/health/privacy", json={"private": True}).status_code == 200

    r = client.post(f"/chats/{chat['id']}/message", json={"content": "Takes 20mg of something"}).json()
    assert r["used_memories"] == [] and r["retrieval"]["withheld_private"] == 1

    # pinning is not a back door around the privacy setting
    r = client.post(f"/chats/{chat['id']}/message", json={
        "content": "hello", "selected_memory_ids": [item["id"]]}).json()
    assert r["used_memories"] == []
    # the user typed the text themselves, so check the memory payload, not the history
    assert all("20mg" not in str(m) for _, m in llm_calls.chats)


def test_pinning_cannot_reach_other_users_memory(client, auth_on, llm_calls):
    tok_a, _ = make_user_token()
    tok_b, _ = make_user_token()
    ha, hb = bearer(tok_a), bearer(tok_b)
    _, msg_a = seed_chat_and_message(client, ha)
    secret = create_memory(client, msg_a, ha, content="A's secret")
    chat_b, _ = seed_chat_and_message(client, hb)

    r = client.post(f"/chats/{chat_b['id']}/message", headers=hb,
                    json={"content": "hi", "selected_memory_ids": [secret["id"]]})
    assert r.status_code == 200
    assert r.json()["used_memories"] == []
    assert "A's secret" not in str(llm_calls.chats)


def test_session_scope_is_fenced_to_its_chat(client):
    chat1, msg = seed_chat_and_message(client)
    chat2 = client.post("/chats", json={"title": "two"}).json()
    create_memory(client, msg, content="Writing a CHI paper", scope="session", session_chat_id=chat1["id"])
    in1 = client.post(f"/chats/{chat1['id']}/message", json={"content": "Writing a CHI paper"}).json()
    in2 = client.post(f"/chats/{chat2['id']}/message", json={"content": "Writing a CHI paper"}).json()
    assert len(in1["used_memories"]) == 1 and in2["used_memories"] == []
    assert in2["retrieval"]["fenced_to_another_chat"] == 1


def test_retrieval_is_correct_with_many_other_users(client, db, llm_calls):
    """The HNSW-filter failure mode: other tenants' nearer vectors must not starve us."""
    from app.services.users import provision_user
    from app.db import pool
    from uuid import uuid4
    from tests.conftest import fake_vector

    chat, msg = seed_chat_and_message(client)
    mine = create_memory(client, msg, content="my unique fact")
    with pool.connection() as conn, conn.cursor() as cur:
        other = uuid4()
        provision_user(cur, other)
        cur.execute("insert into chats (user_id) values (%s) returning id", (other,))
        cid = cur.fetchone()["id"]
        cur.execute("insert into messages (chat_id, role, content) values (%s,'user','x') returning id", (cid,))
        mid = cur.fetchone()["id"]
        cur.execute("select id from blocks where user_id=%s and is_fallback", (other,))
        bid = cur.fetchone()["id"]
        # 300 other-tenant rows with the *identical* vector to the query: all nearer or equal
        for i in range(300):
            cur.execute(
                """insert into memory_items (user_id, block_id, content, source_type, status, sensitivity,
                   scope, confidence, source_message_id, review_state, embedding)
                   values (%s,%s,%s,'stated','completed','low','persistent',0.9,%s,'accepted',%s)""",
                (other, bid, f"theirs {i}", mid, str(fake_vector("my unique fact"))),
            )
    r = client.post(f"/chats/{chat['id']}/message", json={"content": "my unique fact"}).json()
    assert [m["id"] for m in r["used_memories"]] == [mine["id"]]


def test_llm_failure_is_sanitised(client, llm_calls):
    chat, _ = seed_chat_and_message(client)
    llm_calls.fail_chat = True
    r = client.post(f"/chats/{chat['id']}/message", json={"content": "hi"})
    assert r.status_code == 502
    assert "sk-or-v1" not in r.text and "boom" not in r.text


def test_subnodes_summary_prune_relevance(client):
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content="Building a backend")
    base = f"/memory/items/{item['id']}"
    a = client.post(f"{base}/subnodes", json={"content": "FastAPI"}).json()
    client.post(f"{base}/subnodes", json={"content": "fastapi "})            # duplicate
    client.post(f"{base}/subnodes", json={"content": "weak guess", "confidence": 0.2})
    assert len(client.get(f"{base}/subnodes").json()) == 3

    assert client.patch(f"/memory/subnodes/{a['id']}", json={"category": "Projects"}).json()["category"] == "Projects"
    pruned = client.post(f"{base}/prune").json()
    assert pruned["pruned_count"] == 2
    assert [s["content"] for s in client.get(f"{base}/subnodes").json()] == ["FastAPI"]

    summ = client.get(f"{base}/summary").json()
    assert summ["subnode_count"] == 1 and summ["summary"]

    scores = client.post("/memory/relevance", json={"prompt": "Building a backend"}).json()["scores"]
    assert scores[item["id"]] > 0.99

    assert client.delete(f"/memory/subnodes/{a['id']}").json()["status"] == "deleted"
    assert client.delete(f"/memory/subnodes/{a['id']}").status_code == 404


def test_summary_of_private_block_never_calls_model(client, monkeypatch):
    from app.services import llm
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content="private thing", block_name="health")
    client.patch("/memory/blocks/health/privacy", json={"private": True})
    monkeypatch.setattr(llm, "summarize_item", lambda *a, **k: (_ for _ in ()).throw(AssertionError("sent to model")))
    assert client.get(f"/memory/items/{item['id']}/summary").status_code == 200


def test_extraction_audit_reason_with_apostrophes(client, llm_calls, db):
    """Regression: reason strings containing quotes used to produce invalid JSON."""
    from app.services.llm import ExtractedCandidate
    llm_calls.extract_result = [ExtractedCandidate(
        content="Likes tea", evidence="I like tea", source_type="stated", status="in_progress",
        sensitivity="low", block="not-a-real-block", confidence=0.95)]
    chat = client.post("/chats", json={}).json()
    r = client.post(f"/chats/{chat['id']}/message", json={"content": "I like tea"}).json()
    c = client.get(f"/chats/{chat['id']}/candidates", params={"message_id": r["user_message"]["id"]}).json()
    assert c["status"] == "done", c
    assert len(c["candidates"]) + len(c["auto_accepted"]) == 1


def test_request_size_and_validation_limits(client):
    chat = client.post("/chats", json={}).json()
    assert client.post(f"/chats/{chat['id']}/message", json={"content": "x" * 9000}).status_code == 422
    big = client.post(f"/chats/{chat['id']}/message", content=b"{" + b" " * 300_000 + b"}",
                      headers={"content-type": "application/json"})
    assert big.status_code == 413


def test_default_blocks_match_migrations(db):
    from app.services.users import DEFAULT_BLOCKS
    rows = db.execute(
        """select name, default_sensitivity::text as s, restrictive_rank as r, is_fallback as f
           from blocks where user_id = %s order by restrictive_rank""", (DEMO,)).fetchall()
    assert [(x["name"], x["s"], x["r"], x["f"]) for x in rows] == [tuple(b) for b in DEFAULT_BLOCKS]


def test_rls_enabled_on_every_table(db):
    rows = db.execute(
        "select tablename from pg_tables t join pg_class c on c.relname = t.tablename "
        "where t.schemaname='public' and not c.relrowsecurity").fetchall()
    assert rows == []


def test_no_db_connection_is_held_during_the_llm_call(client, monkeypatch):
    """Regression: turns used to hold a pooled connection across the completion, so
    `db_pool_max` slow turns starved every other request."""
    from app.db import pool
    from app.services import llm

    checked_out = {}

    def slow_chat(history, memory, provider=None):
        st = pool.get_stats()
        checked_out["n"] = st["pool_size"] - st["pool_available"]
        return "r", "openrouter", "m", ""

    monkeypatch.setattr(llm, "chat_response", slow_chat)
    chat = client.post("/chats", json={}).json()
    assert client.post(f"/chats/{chat['id']}/message", json={"content": "hi"}).status_code == 200
    assert checked_out["n"] == 0
