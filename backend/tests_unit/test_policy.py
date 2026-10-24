"""policy.decide truth table plus calibration and budget-simulation metrics (hand-computed)."""

from __future__ import annotations

import itertools
import sys
from pathlib import Path

import pytest

from app.models import AssertionStatus, ReviewState, Scope, Sensitivity, SourceType
from app.services import policy

EVAL = Path(__file__).resolve().parents[1] / "eval"
sys.path.insert(0, str(EVAL))

import calibrate_policy as cal  # noqa: E402
import simulate_budget as sim  # noqa: E402

ROWS = cal.load(str(EVAL / "fixtures" / "calibration_items.jsonl"))
CANDS = cal.load(str(EVAL / "fixtures" / "turn_candidates.jsonl"))
BANDS = [0.30, 0.70, 0.90]  # below trust, between trust and auto-accept, above auto-accept


def run(src, sens, conf, status):
    return policy.decide(
        source_type=src, sensitivity=sens, confidence=conf,
        proposed_block="work", known_blocks={"work", "other"}, fallback_block="other",
        status=status,
    )


@pytest.mark.parametrize(
    "src,sens,conf,status",
    list(itertools.product(SourceType, Sensitivity, BANDS, [None, *AssertionStatus])),
)
def test_truth_table(src, sens, conf, status):
    d = run(src, sens, conf, status)
    base = run(src, sens, conf, None)
    auto = (
        src is SourceType.stated and sens is Sensitivity.low
        and conf >= policy.AUTO_ACCEPT_MIN_CONFIDENCE and status is not AssertionStatus.third_party
    )
    assert d.needs_review is (not auto)
    assert d.review_state is (ReviewState.auto_accepted if auto else ReviewState.pending)
    assert d.block_name == ("other" if conf < policy.TRUST_BLOCK_ABOVE else "work")
    if status is AssertionStatus.third_party:
        assert d.scope is Scope.session
        assert policy.THIRD_PARTY_REASON in d.reason
    else:
        assert d == base  # every non-third-party status behaves as before
    # never less restrictive than the status-free decision
    assert d.needs_review >= base.needs_review
    assert (d.scope is Scope.session) >= (base.scope is Scope.session)


def test_third_party_reason_text():
    assert policy.THIRD_PARTY_REASON == "About someone else, who cannot see or remove this."


def test_outcome_and_regret_counts():
    # auto: items 1,2,3,4,12; only item 2 was edited
    assert cal.regret(ROWS) == pytest.approx(1 / 5)
    # pending with a decision: 5,6,7,8,9,10; changed: 6,8,9; item 11 undecided
    assert cal.review_yield(ROWS) == pytest.approx(3 / 6)
    assert cal.outcome(ROWS[10]) is None


def test_reliability_and_ece():
    t = {b["bin"]: b for b in cal.reliability_table(ROWS)}
    assert sum(b["n"] for b in t.values()) == 11
    assert t["0.9-1.0"]["n"] == 3 and t["0.9-1.0"]["agreement"] == pytest.approx(2 / 3)
    assert t["0.8-0.9"]["agreement"] == pytest.approx(1.0)
    assert t["0.5-0.6"]["agreement"] == 0.0
    # (3*|2/3-.92333| + 3*|1-.84333| + 2*.24 + 2*.125 + .55) / 11
    assert cal.ece(ROWS) == pytest.approx(2.52 / 11, abs=1e-6)


def test_ece_perfect_and_empty():
    rows = [{"confidence": 1.0, "disposition": "auto_accepted", "actions": []}]
    assert cal.ece(rows) == pytest.approx(0.0)
    assert cal.ece([]) is None


def test_sweep_values_and_monotonicity():
    sw = {p["threshold"]: p for p in cal.sweep(ROWS)}
    assert list(sw) == cal.THRESHOLDS and len(sw) == 10
    prompts = [sw[t]["prompts_per_item"] for t in cal.THRESHOLDS]
    assert prompts == sorted(prompts)  # a higher bar never prompts less
    assert sw[0.80]["n_auto"] == 6 and sw[0.80]["regret"] == pytest.approx(1 / 6)
    assert sw[0.85]["n_auto"] == 5 and sw[0.85]["regret"] == pytest.approx(1 / 5)
    assert policy.AUTO_ACCEPT_MIN_CONFIDENCE == 0.85  # replay restores the constant


def test_pareto_drops_dominated_points():
    pts = [
        {"threshold": 0.5, "prompts_per_item": 0.4, "regret": 0.3},
        {"threshold": 0.6, "prompts_per_item": 0.5, "regret": 0.3},  # dominated
        {"threshold": 0.7, "prompts_per_item": 0.9, "regret": 0.0},
    ]
    assert [p["threshold"] for p in cal.pareto(pts)] == [0.5, 0.7]


def test_heldout_and_markdown():
    res = cal.analyse(ROWS, split=0.75)
    assert res["heldout"]["train"] == 9 and res["heldout"]["test"] == 3
    md = cal.to_markdown(res)
    assert "informed by 12 items" in md and "validated" not in md.replace("not validation", "")


def test_simulator_counts():
    r = sim.simulate(CANDS)
    assert (r["turns"], r["candidates"], r["prompts_budget_on"]) == (3, 6, 4)
    assert r["per_turn_budget_on"] == pytest.approx(4 / 3)
    assert r["per_turn_all_reviewed"] == pytest.approx(2.0)
    assert r["by_turn"][1]["prompts_budget_on"] == 1
    assert r["by_sensitivity"]["high"] == {"candidates": 1, "prompts_budget_on": 1}
    assert r["by_sensitivity"]["low"] == {"candidates": 5, "prompts_budget_on": 3}
    # at threshold 0.5 the 0.5-confidence candidate is also auto-accepted
    assert sim.simulate(CANDS, 0.5)["prompts_budget_on"] == 3
