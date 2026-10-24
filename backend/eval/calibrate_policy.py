"""Calibration of the review policy against what users actually did.

Input is a JSONL export, one row per memory item:
  {"id", "confidence", "source_type", "sensitivity", "status",
   "disposition": "auto_accepted" | "pending", "actions": ["accepted", "edited", ...]}
`--database-url` builds that export with a read-only query (EXPORT_SQL; never run by tests).
Output says "informed by N items", never "validated": agreement with the user is a signal,
not ground truth, and review outcomes only exist for items that were shown to the user.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import AssertionStatus, Sensitivity, SourceType  # noqa: E402
from app.services import policy  # noqa: E402

CHANGED = {"rejected", "edited", "deleted"}
KEPT = {"accepted", "confirmed"}
THRESHOLDS = [round(0.50 + 0.05 * i, 2) for i in range(10)]  # 0.50 .. 0.95

# shortcut: column and table names assumed from 001_init.sql and never executed here;
# verify against a real database before trusting the export.
EXPORT_SQL = """
select m.id::text as id, m.confidence, m.source_type, m.sensitivity, m.status,
       case when m.review_state = 'auto_accepted' then 'auto_accepted' else 'pending' end
         as disposition,
       coalesce((select array_agg(a.action order by a.created_at)
                 from audit_log a where a.memory_item_id = m.id), '{}') as actions
from memory_items m
"""


def outcome(row: dict) -> str | None:
    """'changed', 'kept', or None when the user has not decided yet."""
    acts = set(row.get("actions") or [])
    if acts & CHANGED:
        return "changed"
    if acts & KEPT or row.get("disposition") == "auto_accepted":
        return "kept"
    return None


def reliability_table(rows: list[dict]) -> list[dict]:
    bins: list[list[dict]] = [[] for _ in range(10)]
    for r in rows:
        if outcome(r) is not None:
            bins[min(int(r["confidence"] * 10), 9)].append(r)
    return [
        {
            "bin": f"{i / 10:.1f}-{(i + 1) / 10:.1f}",
            "n": len(b),
            "mean_confidence": sum(r["confidence"] for r in b) / len(b) if b else None,
            "agreement": sum(outcome(r) == "kept" for r in b) / len(b) if b else None,
        }
        for i, b in enumerate(bins)
    ]


def ece(rows: list[dict]) -> float | None:
    """Expected calibration error, Guo et al. 2017: sum_b (n_b/N) |agreement_b - confidence_b|."""
    t = reliability_table(rows)
    n = sum(b["n"] for b in t)
    if not n:
        return None
    return sum(b["n"] / n * abs(b["agreement"] - b["mean_confidence"]) for b in t if b["n"])


def regret(rows: list[dict]) -> float | None:
    auto = [r for r in rows if r.get("disposition") == "auto_accepted"]
    return sum(outcome(r) == "changed" for r in auto) / len(auto) if auto else None


def review_yield(rows: list[dict]) -> float | None:
    rev = [r for r in rows if r.get("disposition") == "pending" and outcome(r)]
    return sum(outcome(r) == "changed" for r in rev) / len(rev) if rev else None


def replay(row: dict, threshold: float):
    old = policy.AUTO_ACCEPT_MIN_CONFIDENCE
    policy.AUTO_ACCEPT_MIN_CONFIDENCE = threshold
    try:
        return policy.decide(
            source_type=SourceType(row["source_type"]),
            sensitivity=Sensitivity(row["sensitivity"]),
            confidence=row["confidence"],
            proposed_block="b", known_blocks={"b"}, fallback_block="b",
            status=AssertionStatus(row["status"]) if row.get("status") else None,
        )
    finally:
        policy.AUTO_ACCEPT_MIN_CONFIDENCE = old


def sweep(rows: list[dict], thresholds: list[float] = THRESHOLDS) -> list[dict]:
    out = []
    for t in thresholds:
        auto = [r for r in rows if not replay(r, t).needs_review]
        decided = [r for r in auto if outcome(r)]
        reg = sum(outcome(r) == "changed" for r in decided) / len(decided) if decided else 0.0
        out.append({
            "threshold": t,
            "prompts_per_item": (len(rows) - len(auto)) / len(rows) if rows else 0.0,
            "regret": reg,
            "n_auto": len(auto),
        })
    return out


def pareto(points: list[dict]) -> list[dict]:
    """Points no other point beats on both prompts and regret."""
    def dominated(p):
        return any(
            q["prompts_per_item"] <= p["prompts_per_item"] and q["regret"] <= p["regret"]
            and (q["prompts_per_item"], q["regret"]) != (p["prompts_per_item"], p["regret"])
            for q in points
        )
    return [p for p in points if not dominated(p)]


def heldout(rows: list[dict], frac: float, target_regret: float) -> dict:
    """First frac of rows (export order) pick a threshold; the rest score it."""
    k = int(len(rows) * frac)
    train, test = rows[:k], rows[k:]
    ok = [p for p in sweep(train) if p["regret"] <= target_regret]
    if not ok:
        return {"train": len(train), "test": len(test), "chosen": None}
    best = min(ok, key=lambda p: (p["prompts_per_item"], -p["threshold"]))
    return {"train": len(train), "test": len(test), "chosen": best,
            "test_result": sweep(test, [best["threshold"]])[0]}


def analyse(rows: list[dict], split: float | None = None, target_regret: float = 0.05) -> dict:
    sw = sweep(rows)
    res = {
        "informed_by_items": len(rows),
        "reliability": reliability_table(rows),
        "ece": ece(rows),
        "auto_accept_regret": regret(rows),
        "review_yield": review_yield(rows),
        "sweep": sw,
        "pareto": pareto(sw),
    }
    if split:
        res["heldout"] = heldout(rows, split, target_regret)
    return res


def _f(x) -> str:
    return "n/a" if x is None else f"{x:.3f}"


def to_markdown(res: dict) -> str:
    L = [f"Calibration informed by {res['informed_by_items']} items (a signal, not validation).", "",
         "| confidence bin | n | mean confidence | user agreement |", "|---|---|---|---|"]
    L += [f"| {b['bin']} | {b['n']} | {_f(b['mean_confidence'])} | {_f(b['agreement'])} |"
          for b in res["reliability"]]
    L += ["", f"ECE: {_f(res['ece'])}  auto-accept regret: {_f(res['auto_accept_regret'])}"
          f"  review yield: {_f(res['review_yield'])}", "",
          "| threshold | prompts/item | regret | auto-accepted | pareto |", "|---|---|---|---|---|"]
    front = {p["threshold"] for p in res["pareto"]}
    L += [f"| {p['threshold']:.2f} | {p['prompts_per_item']:.3f} | {p['regret']:.3f} | {p['n_auto']} |"
          f" {'yes' if p['threshold'] in front else ''} |" for p in res["sweep"]]
    if "heldout" in res:
        h = res["heldout"]
        L += ["", f"Held-out: train {h['train']}, test {h['test']}, chosen {h['chosen']}"
              f" -> test {h.get('test_result')}"]
    return "\n".join(L)


def load(path: str) -> list[dict]:
    text = Path(path).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def export_from_db(url: str) -> list[dict]:
    import psycopg  # only the DB path needs it
    from psycopg.rows import dict_row

    opts = "-c default_transaction_read_only=on"
    with psycopg.connect(url, options=opts, row_factory=dict_row) as c:
        return list(c.execute(EXPORT_SQL))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--input")
    src.add_argument("--database-url")
    ap.add_argument("--split", type=float, help="train fraction for a held-out evaluation")
    ap.add_argument("--target-regret", type=float, default=0.05)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    rows = load(a.input) if a.input else export_from_db(a.database_url)
    res = analyse(rows, a.split, a.target_regret)
    print(json.dumps(res, indent=2) if a.json else to_markdown(res))


if __name__ == "__main__":
    main()
