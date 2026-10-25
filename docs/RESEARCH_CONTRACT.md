# Phase 9 research contract

The single source of truth for the phase 9 research features (F1-F14 in
`research_feature_proposals.md`, kept outside the repo). Every agent builds against this
file plus the Wave 0 code on `phase-9/contract`. A change that crosses an ownership
boundary goes through the orchestrator, never directly into another agent's files.

## Rules every agent follows

- Read `CLAUDE.md` first. Frontend agents also read `frontend/AGENTS.md` and the
  relevant guide in `frontend/node_modules/next/dist/docs/` before writing Next.js code.
- **No emojis anywhere**: code, comments, UI copy, commits, PR titles and bodies, notes.
- Edit only the files you own (table below). Need a change elsewhere? Write it in your
  hand-off note under "Contract requests" and stop on that point.
- Tests that need no database go in `backend/tests_unit/` and must pass:
  `cd backend && ../.venv/Scripts/python -m pytest -q tests_unit`.
  Tests that need Postgres go in `backend/tests/` (new files only; never edit
  `tests/test_core.py`). They are written and lint-clean but not run during
  development: there is no database. Say so in the PR.
- No Docker, no pgvector container, no database connection, no real model call, no
  dataset download. Mock the LLM the way `tests/conftest.py` does.
- CLAUDE.md test constraints: probe with invented tokens the test seeds itself; keep any
  guard a model could dodge as a pure function and test its failing rows directly.
- Pinned paths stay pinned: extraction, embeddings and the verified draft never read
  `provider`. Only chat is switchable (D32/D33).
- Honesty: nothing claims more than it does. "Withheld from the prompt", not "the model
  does not know". Measured influence is "measured by regenerating", not "caused".
- List view stays primary and complete, WCAG 2.2 AA; every graph action has a list
  equivalent. Status and state are never conveyed by colour alone.
- Commits: small, imperative subject, body says why. End every message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Ownership

| Agent | Features | Files it may write |
|---|---|---|
| A retrieval and turns | F1 enforcement, F3 route, F4 superseded filter, F13, F14 | `backend/app/services/retrieval.py`, `backend/app/routers/chats.py`, `backend/tests/test_flows.py`, `backend/tests_unit/test_retrieval.py`, `backend/eval/sycophancy_audit.py` |
| B1 extraction and classifiers | F3 `influence()`, F4 `propose_relation` + edge writer, F7, F8 `abstracted`, F9 writer | `backend/app/services/classify.py`, `backend/app/services/extraction.py`, `backend/app/services/llm.py`, `backend/tests_unit/test_classify_phase9.py`, `backend/tests_unit/fixtures/relation_pairs.json`, `backend/tests/test_edges.py` |
| B2 policy and calibration | F2, F6 simulation, F8 policy rule | `backend/app/services/policy.py`, `backend/eval/calibrate_policy.py`, `backend/eval/simulate_budget.py`, `backend/tests_unit/test_policy.py` |
| C memory router | F1 flows route + summary/relevance destinations, F4 edge routes + confirmed-only cascade, F9 origin on create/edit, F12 digest | `backend/app/routers/memory.py`, `backend/tests/test_memory_router.py` |
| D PII | F5 | `frontend/lib/pii.ts`, `frontend/scripts/pii_eval.ts`, `frontend/scripts/pii_synthetic_in.json` |
| E memory UI | F2 audit filter, F4, F7, F8, F9 UI, F11 | `frontend/components/ReviewCard.tsx`, `MemoryList.tsx`, `MemoryGraph.tsx`, `MemoryWorkspace.tsx`, `DeletionPreview.tsx`, `frontend/lib/memory-store.tsx`, `frontend/lib/semantics.ts` |
| F turn UI | F1, F3, F10, F12, F13, F14 UI | `frontend/app/(workspace)/app/page.tsx`, `frontend/components/PrivacyBlocks.tsx`, `MemoryTimeline.tsx`, `Attribution.tsx`, `DraftPanel.tsx`, `MemoryPanel.tsx` |
| Orchestrator only | contracts | `backend/app/models.py`, `frontend/lib/api.ts`, `backend/migrations/*`, `backend/app/services/users.py`, `backend/app/config.py`, this file |

## Schema (Wave 0, already written)

- `009_block_flow_rules.sql`: enum `flow_destination` (`chat`, `draft`, `summary`,
  `relevance`); `blocks.denied_destinations flow_destination[] not null default '{}'`.
  health, identity, finance, relationships deny `draft` by default (also for new users,
  `services/users.py` `DRAFT_DENIED_BLOCKS`). `private` still wins over this.
- `010_message_model.sql`: `messages.provider text`, `messages.model text`, nullable.
- `011_edge_state.sql`: enums `edge_state` (`proposed`, `confirmed`, `rejected`) and
  `edge_origin` (`heuristic`, `extraction`, `user`); `memory_edges.state not null default
  'confirmed'`, `memory_edges.origin` nullable. Only `confirmed` counts for cascade and
  retrieval. A `rejected` row stays, so the existing unique (from, to, relation) makes
  re-proposing the same pair a no-op (`on conflict do nothing`).
- `012_memory_item_origin.sql`: enum `content_origin` (`model_worded`, `user_edited`,
  `user_written`), `memory_items.content_origin` nullable, `memory_items.abstracted text`
  nullable.

**psycopg note.** Enum arrays come back as a raw string such as `'{draft}'` because the
type is not registered. Select `denied_destinations::text[] as denied_destinations`.
Scalar enums come back as `str` and are fine.

**Edge direction** (unchanged, SYSTEM_DESIGN §3): `from` is the source, `to` is derived
from it. For `updates`, `from` is the older fact, `to` the newer one; a confirmed
`updates` edge supersedes its `from` end. For `contradicts`, `from` is the older item.
For `derived_from` (F7 premises), `from` is the premise and `to` the inference.

## Python contract (Wave 0, `backend/app/models.py`)

New enums `FlowDestination`, `EdgeState`, `EdgeOrigin`, `ContentOrigin`. New or extended:

- `Message.provider`, `Message.model`
- `MemoryItem.content_origin`, `MemoryItem.abstracted`; `GraphNode.content_origin`
- `Block.denied_destinations`; `BlockFlows` request
- `GraphEdge.id`, `.state`, `.origin` (defaulted, so existing code is unaffected);
  `EdgeProposal`; `EdgeDecision` (`confirmed` | `rejected`)
- `TurnRequest.guest`
- `RetrievalTrace.withheld_by_context`, `.superseded_count`, `.withheld_by_guest`;
  candidate verdicts add `context_denied`, `superseded`, `guest_withheld`
- `RegenerateRequest.exclude_all`
- `InfluenceRequest`, `MemoryInfluence`, `InfluenceResponse`
- `DigestEntry`, `DigestResponse`

Stubs with final signatures:

- `classify.propose_relation(new: dict, old: dict, distance: float) -> tuple[str, str] | None`
  (owner B1)
- `classify.influence(full: str, ablated: str, repeats: list[str]) -> tuple[float, float]`
  returning `(score, noise_floor)` (owner B1; called by A)
- `policy.decide(..., status: AssertionStatus | None = None)` (owner B2; B1 passes the
  candidate's status)

## HTTP contract

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `PATCH /memory/blocks/{name}/flows` | C | `BlockFlows` | `Block` |
| `GET /memory/blocks` (extended) | C | | `list[Block]` with `denied_destinations` |
| `GET /memory/edges?state=proposed` | C | | `list[EdgeProposal]`, caller's live items only |
| `PATCH /memory/edges/{id}` | C | `EdgeDecision` | `GraphEdge`; audit `edge_confirmed` / `edge_rejected` |
| `GET /memory/digest?since=<iso8601>` | C | | `DigestResponse` |
| `POST /chats/{chat_id}/message` (extended) | A | `TurnRequest` with `guest` | `TurnResponse`; trace has the new counts |
| `POST /chats/{chat_id}/regenerate` (extended) | A | `RegenerateRequest` with `exclude_all` | `RegenerateResponse` |
| `POST /chats/{chat_id}/messages/{message_id}/influence` | A | `InfluenceRequest` | `InfluenceResponse`; under `llm_limit` |

Frontend clients for all of these already exist in `frontend/lib/api.ts`:
`setBlockFlows`, `edgeProposals`, `decideEdge`, `digest`, `sendTurn(..., guest)`,
`regenerate(..., excludeAll)`, `measureInfluence`.

## Behaviour per feature

- **F1 (A, C, F).** Retrieval takes a destination; rows whose block denies it get
  verdict `context_denied` and count in `withheld_by_context`. `chat_turn` and
  `regenerate` use `chat`, `verified_draft` uses `draft`. C applies the same rule in
  `node_summary` (`summary`) and `relevance` (`relevance`). F: a per-block checkbox row
  in `PrivacyBlocks.tsx` ("Use in chat / drafts / summaries / relevance"); the timeline
  shows the withheld count.
- **F2 (B2, E).** `eval/calibrate_policy.py` reads `memory_items` and `audit_log` (or a
  JSONL export of them), reports a reliability table, ECE, auto-accept regret and review
  yield, and replays `policy.decide()` across thresholds 0.50-0.95. The core metric code
  is pure and unit-tested on fixtures. E: a list filter for `auto_accepted` items, for an
  end-of-session audit.
- **F3 (A, B1, F).** The route loads the message, its attributions and its stored
  provider/model, regenerates once without each memory and `repeats` times with all of
  them on that same provider, and scores each with `classify.influence`. The baseline is
  a fresh full-context repeat, not the stored reply, which ran under the original
  retrieval set and stale flags. All calls run concurrently (`INFLUENCE_WORKERS` = 4 in
  `routers/chats.py`), and the noise floor is computed once from the repeats. Verdicts:
  `changed_answer` if score > 0.05, `within_noise` if 0 < score <= 0.05,
  `no_measurable_effect` if score <= 0, `failed` on a call error. `chat_turn` and
  `regenerate` now persist `provider`/`model` on the assistant message. F: an on-demand
  "Measure influence" action on the attribution chips that says how it measures.
- **F4 (B1, A, C, E).** After inserting items, extraction finds the nearest live items
  in the same block, calls `propose_relation`, and inserts `proposed` edges with origin
  `heuristic` (no model call). Retrieval drops the `from` end of a confirmed `updates`
  edge: verdict `superseded`. C serves proposals and decisions, and `_cascade` reads only
  confirmed edges. E: "This looks like it updates X: keep both / replace / not related"
  on the review card and the same in the list; the graph draws confirmed edges and marks
  proposed ones with text, not colour alone.
- **F5 (D).** Aadhaar (12 digits, Verhoeff check digit, first digit 2-9), PAN
  (`[A-Z]{5}[0-9]{4}[A-Z]`), UPI handle (`name@bank`, kept apart from email), IFSC
  (`[A-Z]{4}0[A-Z0-9]{6}`). Tiers per principle 3. `pii_eval.ts` runs with
  `node --experimental-strip-types` on a synthetic labelled corpus of invented values plus
  hard negatives, and prints per-category P/R/F1 with and without checksums. It can also
  read an ai4privacy-format JSONL path if one is supplied later; none is downloaded now.
- **F6 (B2).** `eval/simulate_budget.py` replays `decide()` over a JSONL of candidates
  (fixture now, benchmark-derived later) and reports prompts per turn with the budget on
  vs every candidate reviewed. No UI mode and no production switch: that is Phase S.
- **F7 (B1, E).** `ExtractedCandidate.premises: list[str]` holds labels of same-turn
  stated candidates (S1, S2, ...). Extraction writes `derived_from` edges from each
  premise to the inference, state `confirmed`, origin `extraction`; unresolvable labels
  are dropped and logged. E: "inferred from: ..." on the review card and in the list.
- **F8 (B2, B1, E).** `decide()`: `status == third_party` gives session scope and
  review, reason "About someone else, who cannot see or remove this.".
  `ExtractedCandidate.abstracted: str | None` is stored in `memory_items.abstracted`.
  E: keep specific / keep abstracted (writes `content` through the existing PATCH) /
  do not keep.
- **F9 (B1, C, E).** Extraction writes `model_worded`; `edit_item` sets `user_edited`
  when content changes; `create_item` sets `user_written`. E: a text label plus glyph
  in `lib/semantics.ts`, shown in list and graph; nothing shown when null.
- **F10 (F).** In `DraftPanel.tsx`, an overstated claim asks "Where does this actually
  stand?" with status choices, writes the status through `api.edit`, and shows the claim
  as re-checked. No backend change.
- **F11 (E).** A review-queue view of `needs_review` items in `MemoryWorkspace`/`MemoryList`:
  roving focus, announced position ("3 of 7"), documented keys for accept, reject, edit
  and this-chat-only, results through `MemoryLiveRegion`. Every action goes through
  `useMemoryActions()`.
- **F12 (C, F).** Digest entries come from `memory_items` and `audit_log` since a
  timestamp; `stale` uses the same rule as retrieval (`settings.stale_after_days`). F:
  `MemoryPanel.tsx` shows it once per session, dismissible, "last seen" kept in
  `localStorage` inside try/catch.
- **F13 (A, F).** `exclude_all` regenerates with no memories injected and tombstones
  nothing. `eval/sycophancy_audit.py` builds prompts in the SycophancyEval style with
  seeded invented stances, with and without memory, and scores by string match. It runs
  only when invoked with keys; its tests use mocks. F: "Compare without memory" next to
  the existing previous-reply view.
- **F14 (A, F).** `guest` forces the turn ephemeral and caps retrieval at `low`
  sensitivity: verdict `guest_withheld`, count in `withheld_by_guest`. F: a guest toggle
  by the composer that says it is not identity resolution, and a memory panel collapsed
  to counts while it is on.

## Hand-off note (`docs/handoff/<agent>.md`)

What was built; what is stubbed or deferred and why; decisions with rejected
alternatives; contract requests; how to test, including the deferred database steps.

## Draft PR

Base `phase-9/contract`. Title: plain and specific, no emojis. Body sections: What
changed, Why, How to test (commands), Deferred (DB tests not run, no pgvector, no real
model), Open questions. Last line: `Generated with [Claude Code](https://claude.com/claude-code)`.
Never merge.

## Phase S (later, optional)

User studies (planned up to about 100 participants): a `study_events` table and API, a
`review_all` UI condition behind a `study_mode` setting the production validator
refuses, decision timing, trap items, and the F6/F9/F11/F12 protocols. Nothing above
depends on it.
