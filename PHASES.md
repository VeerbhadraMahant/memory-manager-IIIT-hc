# Build Phases

One git branch per phase, each building on the previous. Update the status line and the
"stubbed / not done" notes as you go — this doubles as your honest-limitations record for judging.

Ordering is by demo value, not architectural tidiness. **P1, P3 and P6 are the demo spine.**
If time collapses, those three plus P0 are a coherent submission. P5, P7, P8 are the cut candidates.

---

## P0 — Scaffold and schema
**Status:** done — verified by `python backend/scripts/smoke_p0.py` (19 checks, all passing)
Repo structure, Postgres + pgvector up, tables created, empty FastAPI routes, Next.js shell.
Full schema from `SYSTEM_DESIGN.md` §3 baked in now — retrofitting fields later is worse than
carrying unused columns.

**Done when:** migrations run clean, a memory item can be inserted and read back via API. ✅

Shipped: Supabase Postgres 17.6 + pgvector 0.8.2, full schema in `backend/migrations/001_init.sql`,
demo user + 5 blocks seeded, FastAPI with working chat/message and memory create+read+filter,
Next.js shell rendering live data from the backend (proves CORS end to end).

Two schema fields not spelled out in `SYSTEM_DESIGN.md` §3 that P0 added — see D13 and D14:
`blocks.restrictive_rank` (D3 needs a total order over blocks, a sensitivity tier does not give one)
and `memory_items.session_chat_id` (session scope needs a concrete anchor to enforce against).

---

## P1 — Extraction + candidate surfacing  ← core loop, ship this even if nothing else lands
**Status:** done — verified by `python backend/scripts/smoke_p1.py` (26 checks, all passing)
Post-turn extraction of memory candidates. Stated and inferred kept separate. Review card appears
inline in the conversation, not in a settings page. Accept / reject / edit / rescope.
Auto-accept path for high-confidence, low-sensitivity items (principle 2).

**Done when:** a user can complete a turn, see what the system wants to remember, and change it
without leaving the chat. ✅

Shipped: batched extraction + classification in one schema-enforced Flash call; policy layer
implementing the interruption budget, the restrictive-fallback rule and session-by-default for
sensitive categories; review card inline in the transcript with evidence spans and a stated reason;
accept / discard / edit / rescope, all reachable without leaving the chat.

**Landed earlier than planned**, because the core loop was not demonstrable without them:
- **Retrieval** (vector similarity + scope + review-state filter). Without it the chat had no memory
  to show, so attribution and the P3 leak test would both have been untestable.
- **Attribution rows** written at use time. The P6 UI is not built, but the data is complete from
  the first turn rather than starting when P6 lands.
- **Ephemeral skip.** P3's guarantee is enforced at the extraction pass already; what P3 still owes
  is the cross-session demo and the scripted check.

Measured: chat response 3.9s, extraction 6–9s async. Response never waits on extraction.

---

## P3 — Session scoping + leak test
**Status:** done — verified by `python backend/scripts/leak_test_p3.py` (18 checks, all passing)
Scope enforced at the extraction pass. Ephemeral turns excluded from persistence entirely.

**Done when:** the demo can mark something session-only, start a new session, ask about it, and show
both that the model does not know it *and* that it never entered the store. Build this as a repeatable
scripted check — it is a strong live-demo moment. ✅

Shipped: session switcher in the UI (P3 is not demonstrable without somewhere else to stand);
`GET /chats/{id}/scope-report` reporting what a session can and cannot reach;
`POST /chats/{id}/purge-ephemeral`; and the scripted leak test with a `--no-llm` mode.

### Two different guarantees, deliberately not blurred
The demo should state these separately, because a judge who conflates them will think one of them
is weaker than it is.

1. **Off the record → never written down.** The extraction pass returns before calling the LLM when a
   turn is ephemeral. Nothing is derived from it, so nothing about it exists in the memory store.
   `scope-report.items_from_ephemeral_turns_global` counts memory items whose source message was
   ephemeral, across the whole database. It is structurally 0.
2. **Session-scoped → written down, but fenced.** The item exists, carries a chat anchor, and is
   filtered out in SQL at retrieval for every other chat. The leak test asserts both halves: the fact
   *is* in the store, and every copy of it is session-scoped with an anchor.

### The honest caveat, which should be said before it is asked
An off-the-record turn **is still in the `messages` transcript** and is replayed as history within
its own chat. That is intentional: a model that cannot refer to what you said thirty seconds ago is
broken, not private. "Off the record" governs persistence, not the current conversation — the same
sense a journalist uses it. It is gone in the next session because nothing was ever derived from it.
`POST /chats/{id}/purge-ephemeral` redacts the transcript text too, for anyone who wants that.

### Running it
```
python backend/scripts/leak_test_p3.py --no-llm   # store-level invariants, free
python backend/scripts/leak_test_p3.py            # full, ~3 chat + 2 extraction calls
```
The `--no-llm` mode exists because the strongest evidence here is a database query returning zero
rows, and that should be runnable in front of an audience without spending daily quota.

**Test-design note worth keeping:** the first version of this test probed with the word
"escitalopram" and failed — earlier smoke runs had left *persistent* memories saying the same thing,
which a new session is entitled to recall. The test could not distinguish a leak from a legitimate
recall, which means a passing run would have been meaningless too. Both probes now use invented
tokens that cannot pre-exist in the store.

---

## P2 — Classification
Domain (zero-shot against block names), assertion status (heuristic first, LLM fallback),
sensitivity (regex first, LLM second). Confidence threshold routes low-confidence items to the
restrictive block plus forced review. Inline one-tap correction at the point classification happens.

**Done when:** misclassification is visible and correctable without opening a separate view.

---

## P6 — Use-time attribution + stake-proportional verification  ← strongest differentiator
Responses show which memory items shaped them. Inline revoke and regenerate.
High-stakes output mode (CV, formal document): every memory-derived claim surfaced for confirmation
before it lands in the artifact. Stale in_progress items trigger re-confirmation rather than silent reuse.

**Done when:** you can reproduce the CV failure case — memory says a paper is in progress, the system
refuses to silently render it as completed — and show the "here's what I'd have said without that"
regeneration.

---

## P4 — Memory list view, complete
Search, filter by block/status/sensitivity/scope, bulk actions, full keyboard navigation.
This is the primary interface. It must be complete before any graph work begins.

**Done when:** every memory operation in the system is reachable from this view, keyboard only.

---

## P7 — Pre-send PII intervention
Client-side detection: regex + Luhn for structured PII, format checks for common ID patterns.
Hard interruption only for credentials and live secrets. Everything else sends freely and is handled
at the storage layer with session-only default. Dismissed category = silent for the rest of the session.

**Done when:** detection provably runs locally (show the network tab — nothing leaves the device to
classify), and a false positive can be waved through in one action.

---

## P5 — Provenance graph, scoped to deletion preview
Not a general browser. Its single job: select an item, see what was derived from it and what dies or
degrades if you delete it. Cascade policy per `SYSTEM_DESIGN.md` §3.

**Done when:** deletion preview is accurate, and the same information is available as text for
keyboard/screen-reader users.

---

## P8 — Accessibility pass
WCAG 2.2 AA on the list view. Real screen reader test, not a claimed one — ten minutes with NVDA or
VoiceOver. Live-region announcements for memory state changes. Focus management on the review card.

**Done when:** the full negotiate-a-memory flow is completable without a mouse and without sight.

---

## Stubbed / not done — keep current
(record anything shipped partial, with what is missing)

### As of P0
These routes exist and return **501 with the phase that implements them**, deliberately rather than
404 — "planned, not built" is a different claim from "does not exist", and the API surface from
`SYSTEM_DESIGN.md` §3 should be visible now.

| Route | Returns | Lands in |
|---|---|---|
| `POST /chats/{id}/message` (full turn: retrieve → LLM → attributions) | ✅ built in P1 | — |
| `POST /memory/items/{id}/accept` | ✅ built in P1 | — |
| `POST /memory/items/{id}/reject` | ✅ built in P1 | — |
| `PATCH /memory/items/{id}` | ✅ built in P1 | — |
| `POST /memory/items/{id}/rescope` | ✅ built in P1 | — |
| `POST /memory/items/{id}/confirm` | 501 | P6 |
| `GET /memory/items/{id}/graph` | 501 | P5 |
| `DELETE /memory/items/{id}` | 501 | P5 |

### As of P1

**Superseded — the project moved off Gemini to OpenRouter (D29–D31).** The Gemini free tier was the
top project risk at P1: 20 requests per day, per model, which development testing exhausted in a
single session. That constraint is what the port removed.

**Current LLM risk, restated.** Chat and extraction run on OpenRouter `:free` slugs, which carry a
daily free-tier limit and — the newer hazard — are **retired without notice**; three `:free` slugs
returned 404 during the port itself. Mitigation is that the fallback is a config edit, not a dead
demo: drop the `:free` suffix in `LLM_CHAT_MODEL` / `LLM_EXTRACT_MODEL` to use the paid version of
the same model. Embeddings have no free option and are already paid, at fractions of a cent per
session. Backoff handles per-minute limits.

**What the port cost, stated plainly.** Gemini's explicit per-request safety thresholds have no
OpenAI-compatible equivalent, so filter behaviour is now a property of the chosen model rather than
something the code asserts. The demo content did not trip filters on the configured models, but that
is a test result, not a guarantee. The `thinking_level` control on chat latency (D18) is also gone.

**Runtime model switching (D32).** The composer carries a provider selector — OpenRouter, Gemini and
Groq, populated from whichever keys the server actually has. Switching changes only who writes the
next reply: retrieval, extraction and embeddings stay pinned, so the memory is carried across rather
than re-derived. Verified live by answering on Groq, switching to Gemini mid-conversation, and having
Gemini recall Priya and the deadline from the same store without extracting anything itself.
This turns a provider swap into evidence that the memory layer is the contribution, not the model.
**Also a hedge:** three providers means a retired free slug or an exhausted daily quota is a dropdown
change during the demo rather than a dead session — the single largest operational risk in P1's
original write-up.

Still not done after P1:
- **No provenance edges are written.** `memory_edges` exists and is empty. Nothing detects that
  "10mg escitalopram" *updates* "20mg escitalopram" — both sit in the store as unrelated facts.
  This is visible in the current demo data and is the most obvious gap a judge will find. P5 owns it.
- **No contradiction handling and no decay.** `last_confirmed_at` is set on accept and never read.
- **Attribution is injection, not influence.** The UI says "shaped by N memories", which honestly
  means "N memories were retrieved and put in the prompt". Whether each one changed the wording is
  not measured. P6 should either narrow this or reword it.
- **Auto-accept threshold is untuned.** `confidence >= 0.85` and `sensitivity == low` were chosen by
  argument, not from data. Defensible, but say "chosen" and not "validated" if asked.
- **The memory panel is read-only.** P4 owns the complete filterable, keyboard-navigable list.

Also not done at P0, and **not yet claimed anywhere**:
- **`/health` does not validate the key.** It reports `llm_key_loaded`, which only proves a non-empty
  string was read from `.env`. Real calls have since been made successfully through the OpenRouter
  client (chat, extraction and embeddings all verified end-to-end after the port), but the health
  endpoint itself still proves nothing beyond "a string is present".
- **Safety-filter testing against the demo script is still open**, and is now *less* controllable
  than it was: there is no per-request threshold to set, only a model to choose. See CLAUDE.md.
- **No embeddings are written.** The `vector(768)` column and its HNSW index exist and are empty.
  Retrieval is not implemented, so nothing is being ranked by similarity yet.
- **`POST /memory/items` is a direct insert, not extraction.** It exists for tests and manual entry.
  P1 makes extraction the primary path; this route stays as the escape hatch.
- **No auth.** Single seeded demo user, id hardcoded in `.env`. Every route reads `DEMO_USER_ID`
  rather than a session. Fine for the demo, would not survive contact with a second user.
- **No cascade delete, no tombstone handling.** `deleted_at` exists on the table and every read path
  already filters on it, but nothing sets it yet.
