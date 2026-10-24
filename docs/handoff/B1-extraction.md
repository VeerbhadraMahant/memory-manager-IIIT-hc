# B1 hand-off: extraction and classifiers

## Built
- `classify.influence(full, ablated, repeats)`: token-set Jaccard distance on lowercased
  `[a-z0-9]+` words; floor = mean pairwise distance among repeats (0.0 under two); score =
  distance(full, ablated) - floor. Can be negative (inside noise).
- `classify.propose_relation(new, old, distance)`: pure. Needs same block, distance below
  `RELATION_MAX_DISTANCE` (0.45), and a shared subject (>= 2 shared content words, >= 60% of
  the smaller item's words; stopwords, numbers and month names excluded). Then:
  incompatible statuses (completed/abandoned, planned/abandoned) -> `contradicts`; status
  moved forward (planned -> in_progress -> completed, or in_progress -> abandoned) ->
  `updates`; same status with differing number/dose/date tokens on both sides -> `updates`.
- `extraction.py`: passes `status=` to `policy.decide`; inserts `content_origin =
  'model_worded'` and `abstracted`; after the batch, `NEIGHBOUR_SQL` (exact, per-user
  MATERIALIZED CTE, same block, live accepted/auto_accepted, excludes this batch, k=3) feeds
  `propose_relation`; proposals go in as `proposed`/`heuristic`, `from` = older,
  `on conflict do nothing`. `resolve_premises()` (pure) maps S-labels to ids; edges are
  `derived_from`, `confirmed`, `extraction`; unresolved labels are logged and dropped.
- `llm.py`: `ExtractedCandidate.premises` / `.abstracted` (both defaulted, so old callers and
  tests are unaffected) and prompt text. `_strict_schema` needed no change; a unit test pins
  `list[str]` and nullable string output.

## Deferred
- `backend/tests/test_edges.py` is written and lint-clean but not run (no database).
- No real model call was made, so the prompt wording for S-labels is untested against a model.

## Decisions
- Labels S1.. count only stated candidates, in list order. Rejected: labelling every
  candidate (inferences citing inferences would create chains the contract does not describe).
- Neighbour search uses the final block (after policy), not the model's proposed one.
- Pending (unreviewed) new items still get proposals, so the review card can show them.
  Rejected: waiting for acceptance (the user would decide update-vs-keep after the fact).
- Jaccard over words rather than embeddings for influence: no model call, hand-checkable.
- Number rule requires numbers on both sides; "added detail" is not an update.

## Contract requests
- None required. Optional: C should treat a `proposed` edge whose `from` item was since
  deleted as stale (the FK cascade already removes it).

## How to test
- `cd backend && ../.venv/Scripts/python -m pytest -q tests_unit -s` (prints P/R/F1).
- DB tests: `docker compose up -d db`, `TEST_DATABASE_URL=postgresql://nam:nam@127.0.0.1:5432/nam`,
  `python scripts/migrate.py`, `pytest -q tests/test_edges.py`.

## Detector numbers (55 labelled pairs, invented tokens)
n=55 tp=27 fp=1 fn=4: precision 0.964, recall 0.871, F1 0.915. Known misses are in the
fixture as `LIMIT` rows: paraphrase with no word overlap, number words ("one" -> "two"),
negation ("no longer"), and one false positive (two doses at different times of day).
The fixture was written alongside the rules, so these numbers are optimistic.
