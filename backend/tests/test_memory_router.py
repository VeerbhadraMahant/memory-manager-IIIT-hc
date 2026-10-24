"""Phase 9 memory router: block flows, edge proposals, content origin, digest.

Needs Postgres (see conftest). Probes are invented tokens the test seeds itself.
"""

from __future__ import annotations

from datetime import datetime, timedelta, UTC

from app.config import settings
from tests.conftest import bearer, create_memory, make_user_token, seed_chat_and_message


def _block(client, name):
    return next(b for b in client.get("/memory/blocks").json() if b["name"] == name)


def _edge(db, frm, to, state="proposed", relation="updates"):
    return db.execute(
        """insert into memory_edges (from_item_id, to_item_id, relation, state, origin)
           values (%s,%s,%s,%s,'heuristic') returning id""",
        (frm["id"], to["id"], relation, state),
    ).fetchone()["id"]


def _since(**delta):
    return (datetime.now(UTC) - timedelta(**delta)).isoformat()


# ------------------------------------------------------------------ F1 flows

def test_flows_roundtrip_dedupes_and_lists(client):
    r = client.patch("/memory/blocks/work/flows",
                     json={"denied_destinations": ["summary", "summary", "relevance"]})
    assert r.status_code == 200, r.text
    assert r.json()["denied_destinations"] == ["summary", "relevance"]
    assert _block(client, "work")["denied_destinations"] == ["summary", "relevance"]
    # health ships with draft denied by default (migration 009)
    assert _block(client, "health")["denied_destinations"] == ["draft"]
    # replaces, so an empty list lifts everything
    r = client.patch("/memory/blocks/work/flows", json={"denied_destinations": []})
    assert r.json()["denied_destinations"] == []


def test_flows_unknown_block_404_and_privacy_keeps_flows(client):
    assert client.patch("/memory/blocks/nosuchblock/flows", json={"denied_destinations": []}).status_code == 404
    client.patch("/memory/blocks/work/flows", json={"denied_destinations": ["chat"]})
    r = client.patch("/memory/blocks/work/privacy", json={"private": True})
    assert r.json()["denied_destinations"] == ["chat"]


def test_flows_only_touch_the_callers_block(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    token, _ = make_user_token()
    r = client.patch("/memory/blocks/work/flows", json={"denied_destinations": ["chat"]},
                     headers=bearer(token))
    assert r.status_code == 200, r.text
    monkeypatch.setattr(settings, "auth_required", False)
    assert _block(client, "work")["denied_destinations"] == []


def test_summary_refused_when_block_denies_summary_before_any_llm_call(client, llm_calls, monkeypatch):
    from app.services import llm  # noqa: PLC0415

    _, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content="qzv-4471 prefers tea")
    client.patch("/memory/blocks/work/flows", json={"denied_destinations": ["summary"]})

    def boom(*a, **k):
        raise AssertionError("summarize_item must not run")

    monkeypatch.setattr(llm, "summarize_item", boom)
    r = client.get(f"/memory/items/{item['id']}/summary")
    assert r.status_code == 409
    assert "summar" in r.json()["detail"]

    client.patch("/memory/blocks/work/flows", json={"denied_destinations": []})
    monkeypatch.setattr(llm, "summarize_item", lambda *a, **k: None)
    assert client.get(f"/memory/items/{item['id']}/summary").status_code == 200


def test_relevance_gives_no_score_to_a_block_that_denies_it(client):
    _, msg = seed_chat_and_message(client)
    text = "wplx-9023 lighthouse keeper"
    item = create_memory(client, msg, content=text)
    assert item["id"] in client.post("/memory/relevance", json={"prompt": text}).json()["scores"]
    client.patch("/memory/blocks/work/flows", json={"denied_destinations": ["relevance"]})
    assert item["id"] not in client.post("/memory/relevance", json={"prompt": text}).json()["scores"]


# ------------------------------------------------------------------ F4 edges

def test_proposed_edges_list_and_decision(client, db):
    _, msg = seed_chat_and_message(client)
    old = create_memory(client, msg, content="ghtk-5512 lives in Pune")
    new = create_memory(client, msg, content="ghtk-5512 lives in Leeds")
    gone = create_memory(client, msg, content="ghtk-5512 deleted end")
    edge_id = _edge(db, old, new)
    _edge(db, old, gone)
    _edge(db, new, gone, state="confirmed")
    client.delete(f"/memory/items/{gone['id']}")

    listed = client.get("/memory/edges", params={"state": "proposed"}).json()
    assert [e["id"] for e in listed] == [str(edge_id)]
    assert listed[0]["from_content"] == old["content"] and listed[0]["to_content"] == new["content"]

    r = client.patch(f"/memory/edges/{edge_id}", json={"state": "confirmed"})
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "confirmed" and r.json()["id"] == str(edge_id)
    assert client.get("/memory/edges").json() == []
    assert client.patch(f"/memory/edges/{edge_id}", json={"state": "rejected"}).status_code == 409
    rows = db.execute("select memory_item_id, action, actor from audit_log where action like 'edge_%'"
                      " order by memory_item_id").fetchall()
    # Recorded on both ends, so each memory's history shows the link.
    assert sorted(str(r["memory_item_id"]) for r in rows) == sorted([old["id"], new["id"]])
    assert all((r["action"], r["actor"]) == ("edge_confirmed", "user") for r in rows)


def test_edge_with_a_deleted_end_cannot_be_decided(client, db):
    _, msg = seed_chat_and_message(client)
    a = create_memory(client, msg, content="pqwe-2290 kept")
    b = create_memory(client, msg, content="pqwe-2290 deleted")
    edge_id = _edge(db, a, b)
    client.delete(f"/memory/items/{b['id']}")
    assert client.patch(f"/memory/edges/{edge_id}", json={"state": "confirmed"}).status_code == 409
    assert db.execute("select state from memory_edges where id = %s", (edge_id,)).fetchone()["state"] == "proposed"


def test_rejecting_an_edge_writes_audit_and_hides_it_from_graph(client, db):
    _, msg = seed_chat_and_message(client)
    a = create_memory(client, msg, content="jmrv-1180 first")
    b = create_memory(client, msg, content="jmrv-1180 second")
    edge_id = _edge(db, a, b)
    graph = client.get("/memory/graph").json()
    assert [(e["id"], e["state"], e["origin"]) for e in graph["edges"]] == [(str(edge_id), "proposed", "heuristic")]
    assert all("content_origin" in n for n in graph["nodes"])

    assert client.patch(f"/memory/edges/{edge_id}", json={"state": "rejected"}).status_code == 200
    assert client.get("/memory/graph").json()["edges"] == []
    assert db.execute("select action from audit_log where action = 'edge_rejected'").fetchone()


def test_other_users_edge_is_404(client, db, monkeypatch):
    _, msg = seed_chat_and_message(client)
    a = create_memory(client, msg, content="rtyu-3301 one")
    b = create_memory(client, msg, content="rtyu-3301 two")
    edge_id = _edge(db, a, b)
    monkeypatch.setattr(settings, "auth_required", True)
    token, _ = make_user_token()
    h = bearer(token)
    assert client.get("/memory/edges", headers=h).json() == []
    assert client.patch(f"/memory/edges/{edge_id}", json={"state": "confirmed"}, headers=h).status_code == 404
    assert db.execute("select state from memory_edges where id = %s", (edge_id,)).fetchone()["state"] == "proposed"


def test_cascade_ignores_proposed_edges(client, db):
    _, msg = seed_chat_and_message(client)
    root = create_memory(client, msg, content="vbnm-7710 root")
    child = create_memory(client, msg, content="vbnm-7710 child")
    edge_id = _edge(db, root, child, state="proposed", relation="derived_from")

    cascade = client.get(f"/memory/items/{root['id']}/graph").json()["cascade"]
    assert cascade["cascade_delete"] == [] and cascade["flag_for_review"] == []

    client.patch(f"/memory/edges/{edge_id}", json={"state": "confirmed"})
    cascade = client.get(f"/memory/items/{root['id']}/graph").json()["cascade"]
    assert cascade["cascade_delete"] == [child["id"]]


# ------------------------------------------------------------------ F9 origin

def test_origin_user_written_then_user_edited_only_on_content_change(client):
    _, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content="cdef-2204 original")
    assert item["content_origin"] == "user_written"

    r = client.patch(f"/memory/items/{item['id']}", json={"status": "completed"})
    assert r.json()["content_origin"] == "user_written"
    r = client.patch(f"/memory/items/{item['id']}", json={"content": "cdef-2204 reworded"})
    assert r.json()["content_origin"] == "user_edited"


# ------------------------------------------------------------------ F12 digest

def test_digest_contents_and_counts(client, db):
    _, msg = seed_chat_and_message(client)
    kept = create_memory(client, msg, content="hjkl-6603 kept")
    edited = create_memory(client, msg, content="hjkl-6603 before edit")
    doomed = create_memory(client, msg, content="hjkl-6603 doomed")
    client.patch(f"/memory/items/{edited['id']}", json={"content": "hjkl-6603 after edit"})
    client.delete(f"/memory/items/{doomed['id']}")
    db.execute("insert into audit_log (memory_item_id, action, actor) values (%s,'auto_accepted','system')",
               (kept["id"],))
    stale = create_memory(client, msg, content="hjkl-6603 old work", status="in_progress")
    db.execute(
        "update memory_items set created_at = now() - interval '40 days', "
        "last_confirmed_at = now() - make_interval(days => %s) where id = %s",
        (settings.stale_after_days + 1, stale["id"]),
    )

    body = client.get("/memory/digest", params={"since": _since(days=2)}).json()
    got = {(e["memory_item_id"], e["change"]) for e in body["entries"]}
    assert (kept["id"], "created") in got and (kept["id"], "auto_accepted") in got
    assert (edited["id"], "edited") in got
    assert (doomed["id"], "deleted") in got
    assert (stale["id"], "stale") in got
    assert (stale["id"], "created") not in got
    assert body["counts"]["created"] == 3 and body["counts"]["stale"] == 1
    assert body["counts"]["deleted"] == 1 and body["counts"]["edited"] == 1
    ats = [e["at"] for e in body["entries"]]
    assert ats == sorted(ats, reverse=True)


def test_digest_is_scoped_to_the_caller(client, monkeypatch):
    _, msg = seed_chat_and_message(client)
    create_memory(client, msg, content="uiop-8842 mine")
    monkeypatch.setattr(settings, "auth_required", True)
    token, _ = make_user_token()
    body = client.get("/memory/digest", params={"since": _since(days=1)}, headers=bearer(token)).json()
    assert body["entries"] == [] and body["counts"] == {}


def test_digest_validates_since(client):
    assert client.get("/memory/digest", params={"since": "not-a-date"}).status_code == 422
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert client.get("/memory/digest", params={"since": future}).status_code == 422
    assert client.get("/memory/digest").status_code == 422


# ------------------------------------------------------------------ F8 manual entry

def test_manual_third_party_item_is_session_scoped_and_reviewed(client):
    chat, msg = seed_chat_and_message(client)
    item = create_memory(client, msg, content="lkjh-6604 colleague started treatment",
                         status="third_party", review_state="accepted")
    assert (item["scope"], item["session_chat_id"]) == ("session", chat["id"])
    assert item["review_state"] == "pending" and item["needs_review"] is True
    assert item["review_reason"] == "About someone else, who cannot see or remove this."
