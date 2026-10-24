"""Phase 9 extraction writers: proposed update edges, premise edges, origin, abstracted.

Needs Postgres (see conftest). Invented tokens only; the embedding is stubbed so two
differently worded items sit at distance 0, which the detector's threshold accepts.
"""

from __future__ import annotations

import pytest

from app.services import llm
from app.services.llm import ExtractedCandidate

from tests.conftest import fake_vector


def cand(content, status="in_progress", source_type="stated", **kw):
    base = dict(
        content=content, evidence=content, source_type=source_type, status=status,
        sensitivity="low", block="work", confidence=0.95,
    )
    return ExtractedCandidate(**{**base, **kw})


@pytest.fixture()
def same_vector(monkeypatch):
    monkeypatch.setattr(llm, "embed", lambda texts: [fake_vector("zorqel") for _ in texts])


def turn(client, llm_calls, candidates, text="a turn"):
    llm_calls.extract_result = candidates
    chat = client.post("/chats", json={}).json()
    r = client.post(f"/chats/{chat['id']}/message", json={"content": text}).json()
    return r["user_message"]["id"]


def items(db, mid):
    return db.execute(
        "select id, content, content_origin::text as origin, abstracted, review_state::text as rs"
        " from memory_items where source_message_id = %s order by created_at, content",
        (mid,),
    ).fetchall()


def test_extraction_proposes_updates_edge_for_changed_dose(client, llm_calls, same_vector, db):
    old_mid = turn(client, llm_calls, [cand("Takes zorqel 20 units daily")])
    new_mid = turn(client, llm_calls, [cand("Takes zorqel 10 units daily")])
    (old,), (new,) = items(db, old_mid), items(db, new_mid)

    edges = db.execute(
        "select from_item_id, to_item_id, relation::text as relation, state::text as state,"
        " origin::text as origin from memory_edges"
    ).fetchall()
    assert len(edges) == 1
    e = edges[0]
    assert (e["from_item_id"], e["to_item_id"]) == (old["id"], new["id"])  # older -> newer
    assert (e["relation"], e["state"], e["origin"]) == ("updates", "proposed", "heuristic")


def test_unrelated_items_get_no_edge(client, llm_calls, same_vector, db):
    turn(client, llm_calls, [cand("Takes zorqel 20 units daily")])
    turn(client, llm_calls, [cand("Writes the Brennick paper")])
    assert db.execute("select count(*) as n from memory_edges").fetchone()["n"] == 0


def test_premise_labels_become_confirmed_derived_from_edges(client, llm_calls, db):
    mid = turn(client, llm_calls, [
        cand("Writing the Brennick paper"),
        cand("Reviews for the Vandrel journal"),
        cand("Is an active researcher", source_type="inferred", premises=["S1", "s2", "S7"]),
    ])
    by_content = {i["content"]: i["id"] for i in items(db, mid)}
    edges = db.execute(
        "select from_item_id, to_item_id, state::text as state, origin::text as origin,"
        " relation::text as relation from memory_edges"
    ).fetchall()
    inference = by_content["Is an active researcher"]
    assert {e["from_item_id"] for e in edges} == {
        by_content["Writing the Brennick paper"], by_content["Reviews for the Vandrel journal"]}
    assert all(e["to_item_id"] == inference for e in edges)  # S7 dropped, no edge
    assert all((e["relation"], e["state"], e["origin"]) == ("derived_from", "confirmed", "extraction")
               for e in edges)


def test_content_origin_and_abstracted_are_stored(client, llm_calls, db):
    mid = turn(client, llm_calls, [
        cand("Corvane started the zorqel programme", status="third_party",
             abstracted="A colleague started a new programme"),
        cand("Writing the Brennick paper"),
    ])
    rows = {i["content"]: i for i in items(db, mid)}
    assert {r["origin"] for r in rows.values()} == {"model_worded"}
    assert rows["Corvane started the zorqel programme"]["abstracted"] == "A colleague started a new programme"
    assert rows["Writing the Brennick paper"]["abstracted"] is None
