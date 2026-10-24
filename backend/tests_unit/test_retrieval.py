"""Verdict precedence and influence thresholds: pure functions, no database."""

import pytest

from app.services.retrieval import (
    MAX_DISTANCE,
    TOP_K,
    RetrievalTrace,
    influence_verdict,
    row_verdict,
)


def row(**over):
    base = {
        "block_private": False, "denied_destinations": [], "superseded": False,
        "sensitivity": "low", "distance": 0.1,
    }
    return {**base, **over}


def verdict(r, destination="chat", cap=None, excluded=False, kept=0):
    return row_verdict(r, destination=destination, max_sensitivity=cap,
                       excluded=excluded, kept_so_far=kept)


def test_plain_row_is_injected():
    assert verdict(row()) == "injected"


def test_each_branch():
    assert verdict(row(), excluded=True) == "revoked"
    assert verdict(row(block_private=True)) == "private_block"
    assert verdict(row(denied_destinations=["draft"]), destination="draft") == "context_denied"
    assert verdict(row(superseded=True)) == "superseded"
    assert verdict(row(sensitivity="medium"), cap="low") == "guest_withheld"
    assert verdict(row(distance=MAX_DISTANCE + 0.01)) == "too_distant"
    assert verdict(row(), kept=TOP_K) == "too_distant"


def test_flow_rule_is_per_destination():
    r = row(denied_destinations=["draft"])
    assert verdict(r, destination="chat") == "injected"
    assert verdict(r, destination="draft") == "context_denied"


def test_guest_cap_ranks_sensitivity():
    assert verdict(row(sensitivity="low"), cap="low") == "injected"
    for s in ("medium", "high", "special_category"):
        assert verdict(row(sensitivity=s), cap="low") == "guest_withheld"
    assert verdict(row(sensitivity="high"), cap="medium") == "guest_withheld"
    assert verdict(row(sensitivity="medium"), cap="medium") == "injected"
    assert verdict(row(sensitivity="special_category")) == "injected"  # no cap


@pytest.mark.parametrize("failing, expected", [
    ({"block_private": True, "denied_destinations": ["draft"], "superseded": True,
      "sensitivity": "high", "distance": 0.9}, "private_block"),
    ({"denied_destinations": ["draft"], "superseded": True,
      "sensitivity": "high", "distance": 0.9}, "context_denied"),
    ({"superseded": True, "sensitivity": "high", "distance": 0.9}, "superseded"),
    ({"sensitivity": "high", "distance": 0.9}, "guest_withheld"),
])
def test_precedence(failing, expected):
    assert verdict(row(**failing), destination="draft", cap="low") == expected


def test_revoked_beats_private():
    assert verdict(row(block_private=True), excluded=True) == "revoked"


def test_missing_denied_destinations_is_not_denied():
    assert verdict({"block_private": False, "sensitivity": "low", "distance": 0.1}) == "injected"


def test_trace_dict_has_new_counts():
    d = RetrievalTrace(query="q", withheld_by_context=1, superseded_count=2,
                       withheld_by_guest=3).as_dict()
    assert (d["withheld_by_context"], d["superseded_count"], d["withheld_by_guest"]) == (1, 2, 3)


@pytest.mark.parametrize("score, expected", [
    (None, "failed"), (0.2, "changed_answer"), (0.0501, "changed_answer"),
    (0.05, "within_noise"), (0.01, "within_noise"),
    (0.0, "no_measurable_effect"), (-0.3, "no_measurable_effect"),
])
def test_influence_verdict(score, expected):
    assert influence_verdict(score) == expected
