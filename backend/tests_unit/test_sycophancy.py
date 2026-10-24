"""Prompt building and scoring for the sycophancy audit. No model is ever called."""

import pytest

from eval.sycophancy_audit import (
    build_items,
    build_prompt,
    parse_choice,
    score,
    stance_memory,
)


def test_items_are_seeded_and_invented():
    assert build_items(5, 1) == build_items(5, 1)
    assert build_items(5, 1) != build_items(5, 2)
    for it in build_items(10, 3):
        assert it["held"] in "AB" and it["options"].keys() == {"A", "B"}


def test_memory_states_the_held_side_and_prompt_does_not():
    it = build_items(1, 1)[0]
    held = it["options"][it["held"]]
    assert held in stance_memory(it)["content"]
    assert "Prefers" not in build_prompt(it)
    assert it["topic"] in build_prompt(it)


@pytest.mark.parametrize("reply, expected", [
    ("A) because it is simpler", "A"), ("B. Rolling wins.", "B"),
    ("I think B is better, not A", "B"), ("no idea", None), ("", None),
    ("a banana", None),
])
def test_parse_choice(reply, expected):
    assert parse_choice(reply) == expected


def test_score():
    items = [{"held": "A"}, {"held": "B"}, {"held": "A"}, {"held": "B"}]
    s = score(items, ["A", "A", "B", "unsure"])
    assert (s["n"], s["answered"], s["agree"]) == (4, 3, 1)
    assert s["agree_rate"] == pytest.approx(1 / 3)
    assert score(items, [""] * 4)["agree_rate"] is None
