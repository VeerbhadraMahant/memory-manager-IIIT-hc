"""Replay policy.decide() over candidates grouped by turn: prompts with the interruption
budget on (decide() as shipped) versus every candidate reviewed.

Input JSONL rows: {"turn", "source_type", "sensitivity", "confidence", "status"}.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from calibrate_policy import load, replay  # noqa: E402

from app.services import policy  # noqa: E402


def simulate(rows: list[dict], threshold: float | None = None) -> dict:
    t = policy.AUTO_ACCEPT_MIN_CONFIDENCE if threshold is None else threshold
    turns: dict = defaultdict(lambda: {"candidates": 0, "prompts_budget_on": 0})
    sens: dict = defaultdict(lambda: {"candidates": 0, "prompts_budget_on": 0})
    for r in rows:
        prompted = int(replay(r, t).needs_review)
        for bucket in (turns[r["turn"]], sens[r["sensitivity"]]):
            bucket["candidates"] += 1
            bucket["prompts_budget_on"] += prompted
    total_c = sum(v["candidates"] for v in turns.values())
    total_p = sum(v["prompts_budget_on"] for v in turns.values())
    return {
        "turns": len(turns),
        "candidates": total_c,
        "prompts_budget_on": total_p,
        "prompts_all_reviewed": total_c,
        "per_turn_budget_on": total_p / len(turns) if turns else 0.0,
        "per_turn_all_reviewed": total_c / len(turns) if turns else 0.0,
        "by_sensitivity": dict(sens),
        "by_turn": dict(turns),
    }


def to_markdown(res: dict) -> str:
    L = ["| turn | candidates | prompts (budget on) | prompts (all reviewed) |", "|---|---|---|---|"]
    L += [f"| {k} | {v['candidates']} | {v['prompts_budget_on']} | {v['candidates']} |"
          for k, v in sorted(res["by_turn"].items(), key=lambda kv: str(kv[0]))]
    L += [f"| total | {res['candidates']} | {res['prompts_budget_on']} | {res['prompts_all_reviewed']} |",
          "", f"Per turn: {res['per_turn_budget_on']:.2f} with budget vs "
          f"{res['per_turn_all_reviewed']:.2f} reviewing everything.", "",
          "| sensitivity | candidates | prompts (budget on) |", "|---|---|---|"]
    L += [f"| {k} | {v['candidates']} | {v['prompts_budget_on']} |"
          for k, v in sorted(res["by_sensitivity"].items())]
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True)
    ap.add_argument("--threshold", type=float)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    res = simulate(load(a.input), a.threshold)
    print(json.dumps(res, indent=2) if a.json else to_markdown(res))


if __name__ == "__main__":
    main()
