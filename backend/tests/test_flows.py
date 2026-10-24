"""Phase 9 retrieval rules checked at the prompt: what the model was handed.

Each probe uses an invented token the test seeds itself, so a hit is a real leak and a
miss is a real withholding. Needs Postgres like the rest of `tests/`.
"""

from types import SimpleNamespace

from tests.conftest import create_memory, seed_chat_and_message

TOKEN = "velquorin-7"


def prompt_text(rec, index=-1) -> str:
    """Everything memory-shaped in the captured chat call."""
    return " ".join(m["content"] for m in rec.chats[index][1])


def capture_draft(monkeypatch):
    from app.services import llm  # noqa: PLC0415

    seen: list[list[dict]] = []

    def fake(instruction, memories):
        seen.append(list(memories))
        return SimpleNamespace(draft="draft text", claims=[])

    monkeypatch.setattr(llm, "verified_draft", fake)
    return seen


def test_denied_draft_block_absent_from_draft_present_in_chat(client, llm_calls, db, monkeypatch):
    chat, msg = seed_chat_and_message(client)
    text = f"Appointment note {TOKEN}"
    create_memory(client, msg, content=text, block_name="health", sensitivity="high")
    db.execute("update blocks set denied_destinations = '{draft}' where name = 'health'")
    seen = capture_draft(monkeypatch)

    r = client.post(f"/chats/{chat['id']}/verified-draft", json={"instruction": text})
    assert r.status_code == 200, r.text
    assert TOKEN not in " ".join(m["content"] for m in seen[-1])

    r = client.post(f"/chats/{chat['id']}/message", json={"content": text}).json()
    assert TOKEN in prompt_text(llm_calls)
    assert r["retrieval"]["withheld_by_context"] == 0


def test_denied_block_is_counted_for_the_denied_destination(client, llm_calls, db, monkeypatch):
    chat, msg = seed_chat_and_message(client)
    text = f"Appointment note {TOKEN}"
    create_memory(client, msg, content=text, block_name="health", sensitivity="high")
    db.execute("update blocks set denied_destinations = '{chat}' where name = 'health'")
    r = client.post(f"/chats/{chat['id']}/message", json={"content": text}).json()
    assert r["used_memories"] == [] and r["retrieval"]["withheld_by_context"] == 1
    assert TOKEN not in prompt_text(llm_calls)


def test_superseded_item_never_reaches_prompt(client, llm_calls, db):
    chat, msg = seed_chat_and_message(client)
    old = create_memory(client, msg, content=f"Lives in Oldtown {TOKEN}")
    new = create_memory(client, msg, content="Lives in Newtown")
    db.execute(
        "insert into memory_edges (from_item_id, to_item_id, relation, state)"
        " values (%s, %s, 'updates', 'confirmed')", (old["id"], new["id"]),
    )
    r = client.post(f"/chats/{chat['id']}/message", json={"content": f"Lives in Oldtown {TOKEN}"}).json()
    assert TOKEN not in prompt_text(llm_calls)
    assert r["retrieval"]["superseded_count"] == 1


def test_proposed_updates_edge_does_not_supersede(client, llm_calls, db):
    chat, msg = seed_chat_and_message(client)
    old = create_memory(client, msg, content=f"Lives in Oldtown {TOKEN}")
    new = create_memory(client, msg, content="Lives in Newtown")
    db.execute(
        "insert into memory_edges (from_item_id, to_item_id, relation, state)"
        " values (%s, %s, 'updates', 'proposed')", (old["id"], new["id"]),
    )
    r = client.post(f"/chats/{chat['id']}/message", json={"content": f"Lives in Oldtown {TOKEN}"}).json()
    assert TOKEN in prompt_text(llm_calls) and r["retrieval"]["superseded_count"] == 0


def test_pending_newer_item_does_not_supersede(client, llm_calls, db):
    # A confirmed edge to a newer fact the user has not accepted must not hide the older one.
    chat, msg = seed_chat_and_message(client)
    old = create_memory(client, msg, content=f"Lives in Oldtown {TOKEN}")
    new = create_memory(client, msg, content="Lives in Newtown", review_state="pending")
    db.execute(
        "insert into memory_edges (from_item_id, to_item_id, relation, state)"
        " values (%s, %s, 'updates', 'confirmed')", (old["id"], new["id"]),
    )
    r = client.post(f"/chats/{chat['id']}/message", json={"content": f"Lives in Oldtown {TOKEN}"}).json()
    assert TOKEN in prompt_text(llm_calls) and r["retrieval"]["superseded_count"] == 0


def test_guest_turn_holds_only_low_tier_and_extracts_nothing(client, llm_calls, db):
    chat, msg = seed_chat_and_message(client)
    create_memory(client, msg, content=f"Likes tea {TOKEN}", sensitivity="low")
    create_memory(client, msg, content="Takes medication zyxorb-3", sensitivity="special_category")
    create_memory(client, msg, content="Salary is plorbent-9", sensitivity="high")
    before = db.execute("select count(*) as n from memory_items").fetchone()["n"]
    llm_calls.extract_result.append(object())  # would be consumed if extraction ran

    r = client.post(f"/chats/{chat['id']}/message", json={
        "content": "Likes tea Takes medication Salary", "guest": True}).json()
    assert r["extraction_running"] is False
    # Retrieval is by embedding distance; ask for each item by its exact text too.
    for q in (f"Likes tea {TOKEN}", "Takes medication zyxorb-3", "Salary is plorbent-9"):
        client.post(f"/chats/{chat['id']}/message", json={"content": q, "guest": True})
    joined = " ".join(prompt_text(llm_calls, i) for i in range(len(llm_calls.chats)))
    assert "zyxorb-3" not in joined and "plorbent-9" not in joined
    assert TOKEN in joined
    rows = db.execute("select extraction_status, session_ephemeral from messages where role='user'"
                      " and content like '%%Likes tea%%'").fetchall()
    assert all(x["session_ephemeral"] and x["extraction_status"] == "skipped" for x in rows)
    assert db.execute("select count(*) as n from memory_items").fetchone()["n"] == before


def test_guest_withheld_is_counted(client, llm_calls):
    chat, msg = seed_chat_and_message(client)
    create_memory(client, msg, content="Salary is plorbent-9", sensitivity="high")
    r = client.post(f"/chats/{chat['id']}/message", json={
        "content": "Salary is plorbent-9", "guest": True}).json()
    assert r["used_memories"] == [] and r["retrieval"]["withheld_by_guest"] == 1


def test_exclude_all_injects_nothing_and_tombstones_nothing(client, llm_calls, db):
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content=f"Plays oboe {TOKEN}")
    first = client.post(f"/chats/{chat['id']}/message", json={"content": f"Plays oboe {TOKEN}"}).json()
    mid = first["assistant_message"]["id"]
    assert TOKEN in prompt_text(llm_calls)

    r = client.post(f"/chats/{chat['id']}/regenerate", json={
        "message_id": mid, "exclude_all": True})
    assert r.status_code == 200, r.text
    assert r.json()["used_memories"] == [] and r.json()["revoked"] == []
    assert llm_calls.chats[-1][1] == []
    live = db.execute("select deleted_at, review_state from memory_items where id = %s",
                      (item["id"],)).fetchone()
    assert live["deleted_at"] is None and live["review_state"] == "accepted"
    n = db.execute("select count(*) as n from attributions where message_id = %s", (mid,)).fetchone()["n"]
    assert n == 1


def test_exclude_all_with_revokes_is_refused(client, llm_calls, db):
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content=f"Plays oboe {TOKEN}")
    first = client.post(f"/chats/{chat['id']}/message", json={"content": f"Plays oboe {TOKEN}"}).json()
    r = client.post(f"/chats/{chat['id']}/regenerate", json={
        "message_id": first["assistant_message"]["id"],
        "revoke_item_ids": [item["id"]], "exclude_all": True})
    assert r.status_code == 422
    live = db.execute("select deleted_at from memory_items where id = %s", (item["id"],)).fetchone()
    assert live["deleted_at"] is None


def test_provider_and_model_persisted_on_assistant_message(client, llm_calls, db):
    chat, _ = seed_chat_and_message(client)
    r = client.post(f"/chats/{chat['id']}/message", json={"content": "hello"}).json()
    row = db.execute("select provider, model from messages where id = %s",
                     (r["assistant_message"]["id"],)).fetchone()
    assert (row["provider"], row["model"]) == ("openrouter", "test-model")


def test_influence_route_makes_k_plus_repeats_calls(client, llm_calls, monkeypatch):
    from app.routers import chats as chats_router  # noqa: PLC0415

    monkeypatch.setattr(chats_router, "influence", lambda full, ablated, repeats: (0.3, 0.01))
    chat, msg = seed_chat_and_message(client)
    create_memory(client, msg, content=f"Plays oboe {TOKEN}")
    first = client.post(f"/chats/{chat['id']}/message", json={"content": f"Plays oboe {TOKEN}"}).json()
    mid = first["assistant_message"]["id"]
    before = len(llm_calls.chats)

    r = client.post(f"/chats/{chat['id']}/messages/{mid}/influence", json={"repeats": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["calls_made"] == 3 and len(llm_calls.chats) - before == 3
    assert body["results"][0]["verdict"] == "changed_answer"
    assert body["provider"] == "openrouter"


def test_influence_baseline_is_a_fresh_repeat_not_the_stored_reply(client, llm_calls, monkeypatch):
    from app.routers import chats as chats_router  # noqa: PLC0415

    seen: list[tuple[str, list[str]]] = []

    def fake(full, ablated, repeats):
        seen.append((full, repeats))
        return 0.3, 0.01

    monkeypatch.setattr(chats_router, "influence", fake)
    chat, msg = seed_chat_and_message(client)
    create_memory(client, msg, content=f"Plays oboe {TOKEN}")
    first = client.post(f"/chats/{chat['id']}/message", json={"content": f"Plays oboe {TOKEN}"}).json()
    r = client.post(f"/chats/{chat['id']}/messages/{first['assistant_message']['id']}/influence",
                    json={"repeats": 2})
    assert r.status_code == 200, r.text
    assert seen and all(full == reps[0] for full, reps in seen)
