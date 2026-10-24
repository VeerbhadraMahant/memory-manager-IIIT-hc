# B2 hand-off: policy and calibration

## What shipped
- `policy.decide()`: `status == third_party` returns session scope, pending review, `needs_review=True`, and adds "About someone else, who cannot see or remove this." to the reason. It only tightens; every other status is unchanged (tested across source_type x sensitivity x 3 confidence bands x all statuses).
- `backend/eval/calibrate_policy.py`: reliability table, ECE (Guo et al., 2017), auto-accept regret, review yield, threshold sweep 0.50-0.95 with Pareto front, optional `--split` (first fraction picks a threshold under `--target-regret`, the rest scores it), `--json`, `--database-url` (read-only query, unexecuted).
- `backend/eval/simulate_budget.py`: prompts per turn with the budget on vs every candidate reviewed, with per-sensitivity breakdown.
- Invented fixtures: `backend/eval/fixtures/calibration_items.jsonl`, `turn_candidates.jsonl`.

## Definitions and caveats
- Disagreement = rejected, edited or deleted. Agreement = accepted/confirmed, or auto-accepted with no change. Pending items with no action yet are excluded from agreement metrics.
- Sweep regret uses outcomes observed under the shipped policy; an item that was reviewed has a review outcome, not an auto-accept outcome. Treat it as an estimate: "informed by N items", not validated.
- Real calibration needs logged data from real use. `EXPORT_SQL` assumes column names from 001_init.sql and was never executed.

## Contract requests
- B1: pass `status=AssertionStatus(c.status)` into `decide()` in `extraction.py`. The call omits it today, so the third_party rule is inert until then.
- DB export assumes `memory_items.review_state = 'auto_accepted'` and `audit_log(memory_item_id, action, created_at)`.

## calibrate_policy.py on the fixture (`--split 0.75`)
```
Calibration informed by 12 items (a signal, not validation).

| confidence bin | n | mean confidence | user agreement |
|---|---|---|---|
| 0.0-0.1 | 0 | n/a | n/a |
| 0.1-0.2 | 0 | n/a | n/a |
| 0.2-0.3 | 0 | n/a | n/a |
| 0.3-0.4 | 0 | n/a | n/a |
| 0.4-0.5 | 0 | n/a | n/a |
| 0.5-0.6 | 1 | 0.550 | 0.000 |
| 0.6-0.7 | 2 | 0.625 | 0.500 |
| 0.7-0.8 | 2 | 0.740 | 0.500 |
| 0.8-0.9 | 3 | 0.843 | 1.000 |
| 0.9-1.0 | 3 | 0.923 | 0.667 |

ECE: 0.229  auto-accept regret: 0.200  review yield: 0.500

| threshold | prompts/item | regret | auto-accepted | pareto |
|---|---|---|---|---|
| 0.50 | 0.417 | 0.286 | 7 | yes |
| 0.55 | 0.417 | 0.286 | 7 | yes |
| 0.60 | 0.417 | 0.286 | 7 | yes |
| 0.65 | 0.417 | 0.286 | 7 | yes |
| 0.70 | 0.417 | 0.286 | 7 | yes |
| 0.75 | 0.417 | 0.286 | 7 | yes |
| 0.80 | 0.500 | 0.167 | 6 | yes |
| 0.85 | 0.583 | 0.200 | 5 |  |
| 0.90 | 0.750 | 0.333 | 3 |  |
| 0.95 | 0.917 | 0.000 | 1 | yes |
```

## simulate_budget.py on the fixture
```
| turn | candidates | prompts (budget on) | prompts (all reviewed) |
|---|---|---|---|
| 1 | 2 | 1 | 2 |
| 2 | 3 | 2 | 3 |
| 3 | 1 | 1 | 1 |
| total | 6 | 4 | 6 |

Per turn: 1.33 with budget vs 2.00 reviewing everything.

| sensitivity | candidates | prompts (budget on) |
|---|---|---|
| high | 1 | 1 |
| low | 5 | 3 |
```
