# Project details — Negotiated AI Memory

Technical companion to `PRD.md`. This is the "how" and "what shipped"; `PRD.md` is the "why."
Full decision history with rejected alternatives lives in `DECISION_LOG.md` (47 entries) — this
file curates the load-bearing ones rather than reproducing all of them.

---

## 1. What it is, in one paragraph

A chat interface backed by Postgres + pgvector, where after each turn a fact-extraction pass
proposes memory candidates — kept separate as *stated* (the user said it) or *inferred* (the model
worked it out) — and the user accepts, edits, rescopes or discards each one inline, before it
persists. Memory is either `persistent` (usable across conversations) or `session` (fenced to one
chat, never returned to any other, and structurally excluded from the vector store when the turn is
marked off-the-record). Every response is labelled with the memories that shaped it, revocable
one at a time with the answer re-generated to show the difference. A stake-proportional check runs
before any high-stakes artifact (a CV, a formal document) is produced, verifying every
memory-derived claim in the draft against the item's actual `assertion_status` — in Python, as a
pure function, not by asking the model to grade itself.

## 2. Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind v4 (CSS-first `@theme`, no `tailwind.config.js`) |
| Backend | FastAPI, psycopg3 |
| Storage | Postgres + pgvector (developed against Supabase free tier) |
| Chat LLM | OpenRouter, Groq, Gemini — switchable per turn from the composer |
| Extraction / classification / embeddings | Pinned regardless of chat provider (see §4) |
| Graph rendering | React Flow, deterministic `dagre` layout |

## 3. Data flow, one turn

1. Client-side PII scan (regex + Luhn, zero network calls) on send. Structured, irreversible PII
   (card numbers, credentials, government IDs) hard-blocks with a redact-or-send-as-is choice.
   Sensitive-but-legitimate categories (health, address, email) send freely and default to
   session-only at the storage layer — friction is proportional to irreversibility, not sensitivity.
2. Message sent. Retrieval filters candidate memories by scope, block and vector similarity, injects
   them as context, and the chosen chat provider responds. The response returns **with
   attribution** — the specific memory item ids that shaped it.
3. Async, after the response: extraction pulls candidates from the turn; classification tags domain,
   assertion status and sensitivity. High-confidence, low-sensitivity items are kept quietly (the
   interruption budget); everything else surfaces as a review card attached to that turn.
4. If the turn was marked off-the-record, step 3 never runs — the extraction pass returns before the
   LLM is called at all. This is the structural guarantee behind "use this now, don't keep it,"
   verified live by `leak_test_p3.py`.

## 4. LLM usage rules — why the split exists

Only **chat** is switchable between providers. Extraction, embeddings, and the high-stakes draft's
claim decomposition are pinned, and this is deliberate rather than incidental:

- Switching the embedding model silently fragments the vector space — pgvector returns *plausible
  but wrong* results across a mixed space rather than erroring (D31). A model switch mid-demo must
  never touch embeddings.
- Routing extraction or the verification pass through a chat dropdown would make status
  classification — the field the whole CV-case defense rests on — non-reproducible from one demo run
  to the next (D33).
- The *stronger* model does extraction/classification (runs off the user-facing critical path); the
  *faster* model answers chat (the call the user is waiting on). Collapsing this into one model
  trades away the reason for the split.

The response always reports which provider **actually** answered, not which was requested — an
unconfigured or retired slug falls back rather than failing the turn (D32).

## 5. Where the design principles live in code

| Principle | Enforced in |
|---|---|
| Session scope is real, not a UI filter | `services/extraction.py` (skip) + `services/retrieval.py` (SQL), proved by `leak_test_p3.py` |
| Interruption budget | `services/policy.py` — `AUTO_ACCEPT_*` |
| Low confidence → more restrictive block, forced review | `services/policy.py` — `TRUST_BLOCK_ABOVE` |
| Sensitive-but-legitimate → session-scoped by default | `services/policy.py` — `SESSION_BY_DEFAULT` |
| No orphaned facts | `source_message_id NOT NULL` in `001_init.sql`; user-written memories cite the most recent real message rather than fabricating one |
| Consequence, not caution | `ReviewCard.tsx` / `Onboarding.tsx` wording, chat prompt in `llm.py` |
| Unfinished work never rendered as finished | `routers/chats.py` `verified_draft`, checked in Python (`classify.check_claim()`), never by asking the model to self-grade |
| Regex may raise sensitivity, never lower it | `services/classify.py` — `raise_sensitivity` |
| Stated vs. inferred never color-only | `lib/semantics.ts` `SOURCE` — fill, border style, glyph and mono label, all four |
| Consent has to change behavior | `lib/consent.ts` read by the composer (`session_ephemeral` defaults to the decision) and writable from the memory panel |

The memory vocabulary (`assertion_status`, `scope`, `sensitivity`, `review_state`) appears in three
places on purpose — Postgres enum, Pydantic model, TypeScript union — so a rename is a visible
three-file diff rather than silent drift.

## 6. Curated decision log

Full list with rejected alternatives in `DECISION_LOG.md`. These are the ones that would change the
demo or the architecture if reversed.

- **D4 — assertion status is first-class.** The originating incident (a stale "in progress" paper
  reaching a CV). See `PRD.md` §1.
- **D5 — friction proportional to irreversibility, not sensitivity.** Hard-block only credentials and
  live secrets; health/address send freely and are handled at storage.
- **D29–D33 — port off Gemini to OpenRouter, multi-provider chat.** Gemini's 20-req/day free tier was
  the top operational risk; the port removed it and turned a provider swap into evidence that the
  memory layer, not the model, is the contribution.
- **D34 — the overstatement detector is tested as a pure function**, because a model asked to
  overstate a claim will usually just decline — an end-to-end test can pass without the guard firing
  even once.
- **D37 / D47 — contrast and accessible names are audited against the running DOM and the real
  accessibility tree**, not against token pairs or attribute presence. Both approaches caught real
  bugs the cheaper check missed: D37 found chips at 4.38:1 that a palette-level check had passed;
  D47 found four controls with a correct `aria-label` in source that Chrome computed as an *empty*
  accessible name at runtime, because their visible text was split across sibling elements.
- **D42 → D44 — the memory panel went from a permanent 50/50 split to a collapsible column.** The
  split fixed graph-under-the-fold visibility but made memory compete with the transcript at every
  moment, including when the transcript was what mattered (a projector demo). Collapsing preserves
  visibility (the toggle always carries the live item count) without the constant competition.
- **D45 — palette moved from a placeholder dark scheme to the supplied light palette**, re-running
  the D37 contrast audit rather than assuming the swap was safe; it caught three tokens that had
  silently become invisible or inverted in meaning (a "flagged" heading rendering in the color that
  means "you said this").
- **D46 — the graph got a full-page tab reusing the same `<MemoryWorkspace>` component** the side
  panel uses, rather than a bespoke graph-only page, so "nothing is reachable only via the graph"
  stays a property of *which component renders* rather than a rule that has to be remembered in a
  second implementation.

## 7. Build status by phase

| Phase | What it is | Status |
|---|---|---|
| P0 | Schema, scaffold | Done — `smoke_p0.py`, 19 checks |
| P1 | Extraction + candidate surfacing (the core loop) | Done — `smoke_p1.py`, 26 checks |
| P3 | Session scoping + leak test | Done — `leak_test_p3.py`, 18 checks; the one claim proven live |
| P2 | Classification + one-tap correction | Done — `smoke_p2_p6.py --no-llm` |
| P6 | Use-time attribution + stake-proportional verification | Done — the CV case, reproduced |
| P4 | Complete memory list view | Done |
| P7 | Pre-send PII intervention | Done — client-side only, verified with `fetch` instrumented (zero network calls before Send) |
| P5 | Provenance graph, deletion preview | **Shipped with a stated gap** — see §8 |
| P8 | Accessibility pass | Substantially done — a real NVDA/VoiceOver session is the one item still open; everything else is machine-verified |

**Beyond the original phase plan**, built in a later UI pass and not yet reflected in `PHASES.md`'s
numbering:
- Three-zone responsive shell (collapsible session sidebar, centered conversation, collapsible memory
  panel) replacing the original fixed two-column split, with focus-trap and reduced-motion handling.
- Light palette on the team's supplied brand colors, replacing placeholder dark tokens, re-verified
  for contrast rather than assumed safe.
- A full-page graph exploration tab, reachable from two places, that never duplicates List's action
  surface.
- Onboarding rebuilt as a three-step flow (what memory is → disclaimer → explicit opt-in/decline)
  whose decision is wired to actual behavior, not just recorded.
- User-created memory ("+ Add memory") — a memory the user asserts directly, at full confidence,
  skipping review because the user just wrote it themselves.

## 8. Known gaps — stated plainly

- **`DELETE /memory/items/{id}` currently returns 500.** The handler's only line is a call to
  `_todo(...)`, and `_todo` is not defined anywhere in the codebase — it was removed when the P0
  stub-cleanup happened and this call site was missed. `PHASES.md` describes this route as built;
  it is not currently functional. Everything else in the deletion flow (the preview, the cascade
  sections, the honest "tombstoned, not erased" copy) works — only the final confirm fails. One-line
  fix, not attempted here because backend changes were out of scope for the pass that found it.
- **`memory_edges` is never written.** The cascade-delete *reader* is correct against an empty edge
  set (it reports zero dependents, and says so on screen rather than looking merely sparse) — the
  *writer* that would notice "10mg escitalopram" updates "20mg escitalopram" does not exist.
- **No contradiction handling.** Decay is handled (a stale `in_progress` item is dated, not asserted,
  in the chat prompt) — but nothing notices that two stored facts disagree with each other.
- **Attribution is injection, not measured influence.** "Shaped by N memories" means N memories were
  retrieved and placed in the prompt; whether each one changed the wording is not measured. Revoke +
  regenerate demonstrates influence for one item at a time, which is evidence, not a measurement.
- **Auto-accept threshold (`confidence ≥ 0.85`, `sensitivity == low`) is chosen by argument**, not
  tuned against data. Say "chosen," not "validated," if asked.
- **`/health`'s `llm_key_loaded` only proves a non-empty string was read from `.env`** — it does not
  validate the key against the provider.
- **No auth.** Single hardcoded demo user; every route reads `DEMO_USER_ID`. Would not survive a
  second user.

## 9. Setup and run

Requires Python 3.11+, Node 20+, and a Postgres database with pgvector (developed against Supabase
free tier).

```bash
cp .env.example .env   # fill in DATABASE_URL and LLM_API_KEY (openrouter.ai/keys)

python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt   # Windows
.venv/Scripts/python backend/scripts/migrate.py                   # schema + seed

cd frontend && npm install
```

Two terminals:

```bash
# API — :8000, docs at /docs
cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# UI — :3000
cd frontend && npm run dev
```

Verification, cheapest first:

```bash
.venv/Scripts/python backend/scripts/smoke_p0.py               # schema + API, no LLM calls
.venv/Scripts/python backend/scripts/leak_test_p3.py --no-llm  # session-scope guarantee, free
.venv/Scripts/python backend/scripts/smoke_p2_p6.py --no-llm   # classifier truth tables, free
.venv/Scripts/python backend/scripts/smoke_p1.py               # full loop — real LLM calls, costs quota
.venv/Scripts/python backend/scripts/leak_test_p3.py           # full leak test — real LLM calls
.venv/Scripts/python backend/scripts/smoke_p2_p6.py            # + CV failure case, revoke, decay
```

The `--no-llm` modes are the ones to run in front of an audience: free, deterministic, and — per
D34 — the strongest evidence, because they walk the check directly rather than hoping a live model
fails in the right way on cue.

> Chat and extraction run on OpenRouter `:free` model slugs, which are rate-limited per day and are
> retired without notice. If chat starts failing, check the slug is still listed before debugging
> anything else; dropping the `:free` suffix in `LLM_CHAT_MODEL` / `LLM_EXTRACT_MODEL` falls back to
> the paid version of the same model.
