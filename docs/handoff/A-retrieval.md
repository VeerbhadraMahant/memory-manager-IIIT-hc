# Hand-off: A, retrieval and turns

## Built

- `services/retrieval.py`: `retrieve_traced`, `retrieve`, `pinned` take keyword-only
  `destination` (default `chat`) and `max_sensitivity`. The per-row decision is the pure
  `row_verdict()`; precedence is revoked, private, flow rule (`context_denied`),
  `superseded`, guest cap (`guest_withheld`), then distance/top-k. SQL selects
  `denied_destinations::text[]` and a `superseded` flag (a confirmed `updates` edge whose
  `to` end is not deleted). `RetrievalTrace` and `as_dict()` carry the three new counts.
  `influence_verdict()` holds the F3 thresholds.
- `routers/chats.py`: `chat_turn` uses `chat`, `verified_draft` uses `draft`, `regenerate`
  uses `chat`. Provider and model are stored on assistant messages (insert and regenerate
  update). `guest` forces the turn ephemeral (extraction skipped) and caps retrieval at
  `low`. `exclude_all` regenerates with nothing injected. New
  `POST /chats/{id}/messages/{mid}/influence` under `llm_limit`.
- `eval/sycophancy_audit.py` with pure prompt building and scoring.
- Tests: `tests_unit/test_retrieval.py`, `tests_unit/test_sycophancy.py` (pass);
  `tests/test_flows.py` (written, lint-clean, not run).

## Deferred

- DB tests not run (no database, no pgvector). SQL is unexecuted; the `superseded`
  subquery and `denied_destinations::text[]` cast are the parts most worth a first run.
- `classify.influence` is a stub owned by B1; the route calls it as specified.
- The audit script was never run against a model.

## Decisions

- `exclude_all` returns the no-memory answer but does NOT overwrite the stored reply or its
  attributions ("a comparison, not a decision"). Rejected: replacing the message like a
  normal regenerate, which would destroy the reply being compared against.
- `exclude_all` ignores `revoke_item_ids` entirely (tombstones nothing).
- Influence: repeats run first, then one ablation per attributed memory, sequentially.
  Rejected: threads, because the rate limiter and provider quotas make parallel bursts a
  risk and k is small. Attributed memories that were since deleted are skipped. With no
  attributions it returns `calls_made = 0`. If fewer than 2 repeats succeed, every
  result is `failed`. A message with no stored provider uses the default; the response
  `provider` field shows which one ran.
- The influence `full` baseline is the stored reply, not a fresh full-context call.
- Pinned turns apply the same flow, supersession and guest rules; the relevance cut does
  not apply to pinned rows.
- Superseded check treats a `to` end as live when `deleted_at is null` (review state not
  considered). Rejected: also requiring accepted, since a pending newer fact should not
  make the user's confirmed edge a no-op, but this is a judgement call.
- Guest: the user message is also marked `session_ephemeral`, so it is redacted by
  purge-ephemeral like other off-the-record turns.

## Contract requests

- None blocking. Optional: `Message` could expose `provider`/`model` on the influence
  response path (already present on `Message`).

## How to test

- `cd backend && ../.venv/Scripts/python -m pytest -q tests_unit`
- `ruff check backend`
- DB tests: `docker compose up -d db`, set
  `TEST_DATABASE_URL=postgresql://nam:nam@127.0.0.1:5432/nam`, run
  `python scripts/migrate.py`, then `pytest -q`.
- Audit (costs quota): `python -m eval.sycophancy_audit --n 20 --seed 1`.
