# Agent C: memory router

## Built (backend/app/routers/memory.py)
- F1: `list_blocks` / `set_block_privacy` return `denied_destinations` (cast to `text[]`).
  New `PATCH /memory/blocks/{name}/flows` (replace, dedupe, 404 if not the caller's).
  `node_summary` answers 409 before any LLM call when the block denies `summary`
  (checked before the private branch). `relevance` drops items whose block denies `relevance`.
- F4: `GET /memory/edges?state=` (default proposed; both ends the caller's live items,
  newest first). `PATCH /memory/edges/{id}`: 404 unless both ends are the caller's, 409 unless
  `proposed` (the update is guarded by `state = 'proposed'`, so a race also yields 409).
  Audit rows `edge_confirmed` / `edge_rejected`, actor user, attached to the `from` item
  (audit_log.memory_item_id is not null) with the edge id in `detail`.
  `_cascade` reads only confirmed edges, including the contradicts/updates lookup.
  `full_graph` / `item_graph` return edge id, state, origin, include proposed, never rejected.
- F9: `create_item` writes `user_written`; `edit_item` writes `user_edited` only on a content change.
  `GRAPH_SELECT` includes `content_origin`.
- F12: `GET /memory/digest?since=`. Created = `memory_items.created_at`; auto_accepted, edited,
  flagged_for_review, deleted (including `deleted_by_cascade`) come from `audit_log`; stale =
  in_progress, accepted/auto_accepted, live, whose `coalesce(last_confirmed_at, created_at) +
  stale_after_days` falls between `since` and now. 200 entries max; `counts` covers all.

## Decisions
- Created is read from `memory_items`, not the `created` audit row, because extraction writes
  `auto_accepted` / `surfaced_for_review` rows and no `created` row. Rejected: audit-only.
- Stale reports items that became stale inside the window, not every currently stale item,
  so the digest shows what changed. Rejected: all stale items each time.
- `since` without a timezone is read as UTC.

## Contract requests
None.

## Testing
- `cd backend && ../.venv/Scripts/python -m pytest -q tests_unit` (passes).
- DB tests, not run: `docker compose up -d db`, `TEST_DATABASE_URL=postgresql://nam:nam@127.0.0.1:5432/nam`,
  run `backend/scripts/migrate.py`, then `pytest -q` from `backend`.
