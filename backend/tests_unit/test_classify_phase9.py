"""F3 influence, F4 propose_relation, F7 premise resolution. Pure functions only."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import llm
from app.services.classify import RELATION_MAX_DISTANCE, influence, propose_relation
from app.services.extraction import resolve_premises

PAIRS = json.loads((Path(__file__).parent / "fixtures" / "relation_pairs.json").read_text("utf-8"))
# Written after the rules existed, aimed at the three known misses (number words,
# negation, dose time of day) plus guards against over-firing. Scored separately so the
# original 55-pair number stays comparable; these are not a held-out set.
AFTER_RULES = json.loads(
    (Path(__file__).parent / "fixtures" / "relation_pairs_after_rules.json").read_text("utf-8")
)


# ------------------------------------------------------------------ influence


def test_influence_identical_text_is_zero():
    assert influence("a b c", "a b c", []) == (0.0, 0.0)


def test_influence_disjoint_text_is_one():
    score, floor = influence("alpha beta", "gamma delta", ["x y", "x y"])
    assert (score, floor) == (1.0, 0.0)


def test_influence_inside_noise_floor_is_not_positive():
    # repeats differ by half; full vs ablated differ by less than that
    repeats = ["a b c d", "a b x y"]
    score, floor = influence("a b c d", "a b c e", repeats)
    assert floor == pytest.approx(1 - 2 / 6)
    assert score < 0


def test_influence_subtracts_floor():
    score, floor = influence("a b", "c d", ["a b", "a c"])
    assert floor == pytest.approx(1 - 1 / 3)
    assert score == pytest.approx(1.0 - floor)


def test_influence_single_repeat_has_no_floor():
    assert influence("a", "b", ["a"])[1] == 0.0


def test_influence_ignores_case_and_punctuation():
    assert influence("Hello, World!", "hello world", [])[0] == 0.0


# ------------------------------------------------------------ propose_relation


def test_fixture_size():
    assert len(PAIRS) >= 50


def _score(pairs: list[dict], name: str) -> tuple[float, float, list[str]]:
    tp = fp = fn = 0
    wrong = []
    for p in pairs:
        got = propose_relation(p["new"], p["old"], p["distance"])
        got = got[0] if got else None
        if got and got == p["expected"]:
            tp += 1
        elif got:
            fp += 1
            if p["expected"]:
                fn += 1  # proposed the wrong relation: also a miss
        elif p["expected"]:
            fn += 1
        if got != p["expected"]:
            wrong.append(f"{p['id']} [{p['label']}] expected={p['expected']} got={got}")
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    print(f"relation detector ({name}): n={len(pairs)} tp={tp} fp={fp} fn={fn} "
          f"P={precision:.3f} R={recall:.3f} F1={f1:.3f}")
    for w in wrong:
        print("  wrong:", w)
    return precision, recall, wrong


def test_relation_fixture_precision_recall_f1():
    precision, recall, _ = _score(PAIRS, "original 55")
    assert precision >= 0.85
    assert recall >= 0.70


def test_relation_after_rules_set():
    precision, recall, _ = _score(AFTER_RULES, "after-rules set")
    assert precision >= 0.85
    assert recall >= 0.70


def _row(pid: str) -> dict:
    return next(p for p in PAIRS if p["id"] == pid)


def test_zorqel_dose_change_is_an_update():
    p = _row("p01")
    rel, reason = propose_relation(p["new"], p["old"], p["distance"])
    assert rel == "updates" and "20mg" in reason and "10mg" in reason


def test_writing_to_submitted_is_an_update():
    p = _row("p13")
    assert propose_relation(p["new"], p["old"], p["distance"])[0] == "updates"


def test_completed_vs_abandoned_contradicts():
    p = _row("p25")
    assert propose_relation(p["new"], p["old"], p["distance"])[0] == "contradicts"


def test_different_block_is_never_related():
    p = _row("p01")
    other = {**p["old"], "block_name": "learning"}
    assert propose_relation(p["new"], other, p["distance"]) is None


def test_distance_threshold_is_exclusive():
    p = _row("p01")
    assert propose_relation(p["new"], p["old"], RELATION_MAX_DISTANCE) is None
    assert propose_relation(p["new"], p["old"], RELATION_MAX_DISTANCE - 0.01) is not None


def test_one_shared_common_noun_is_not_enough():
    new = {"content": "Submitted the Corvane paper", "status": "completed", "block_name": "work"}
    old = {"content": "Writing the Brennick paper", "status": "in_progress", "block_name": "work"}
    assert propose_relation(new, old, 0.2) is None


def test_backwards_status_is_not_an_update():
    new = {"content": "Writing the Brennick paper", "status": "in_progress", "block_name": "work"}
    old = {"content": "Submitted the Brennick paper", "status": "completed", "block_name": "work"}
    assert propose_relation(new, old, 0.2) is None


def test_accepts_enum_statuses():
    from app.models import AssertionStatus

    new = {"content": "Submitted the Brennick paper", "status": AssertionStatus.completed, "block_name": "work"}
    old = {"content": "Writing the Brennick paper", "status": AssertionStatus.in_progress, "block_name": "work"}
    assert propose_relation(new, old, 0.2)[0] == "updates"


# ------------------------------------------------------------ premise labels


def test_resolve_premises_maps_labels_and_drops_unknown():
    edges, dropped = resolve_premises(
        ["id-a", "id-b", "id-c"],
        ["stated", "stated", "inferred"],
        [[], [], ["S1", "s2", "S2", "bogus", "S3"]],
    )
    assert edges == [("id-a", "id-c"), ("id-b", "id-c")]
    assert dropped == ["bogus", "S3"]


def test_resolve_premises_drops_self_reference_and_unwritten_items():
    edges, dropped = resolve_premises(
        ["id-a", None, "id-c"], ["stated", "stated", "inferred"], [["S1"], [], ["S1", "S2"]]
    )
    assert edges == [("id-a", "id-c")]
    assert dropped == ["S1", "S2"]


def test_resolve_premises_ignores_self_and_inferred_labels():
    # S labels number only the stated candidates: one stated, one inferred.
    edges, dropped = resolve_premises(["id-a", "id-b"], ["stated", "inferred"], [[], ["S1", "S2"]])
    assert edges == [("id-a", "id-b")]
    assert dropped == ["S2"]


# ------------------------------------------------------------ schema


def test_extraction_schema_is_strict_compatible():
    item = llm.EXTRACTION_SCHEMA["properties"]["candidates"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == set(item["properties"])
    assert item["properties"]["premises"]["type"] == "array"
    assert item["properties"]["premises"]["items"] == {"type": "string"}
    kinds = {o.get("type") for o in item["properties"]["abstracted"]["anyOf"]}
    assert kinds == {"string", "null"}
    assert "$ref" not in json.dumps(llm.EXTRACTION_SCHEMA)


def test_candidate_defaults_keep_old_callers_working():
    c = llm.ExtractedCandidate(
        content="x", evidence="x", source_type="stated", status="planned",
        sensitivity="low", block="work", confidence=0.9,
    )
    assert c.premises == [] and c.abstracted is None
