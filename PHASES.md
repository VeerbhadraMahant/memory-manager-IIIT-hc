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
Scope enforced at the extraction pass. Ephemeral turns excluded from persistence entirely.

**Done when:** the demo can mark something session-only, start a new session, ask about it, and show
both that the model does not know it *and* that it never entered the store. Build this as a repeatable
scripted check — it is a strong live-demo moment.

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
| `POST /chats/{id}/message` (full turn: retrieve → Gemini → attributions) | ✅ built in P1 | — |
| `POST /memory/items/{id}/accept` | ✅ built in P1 | — |
| `POST /memory/items/{id}/reject` | ✅ built in P1 | — |
| `PATCH /memory/items/{id}` | ✅ built in P1 | — |
| `POST /memory/items/{id}/rescope` | ✅ built in P1 | — |
| `POST /memory/items/{id}/confirm` | 501 | P6 |
| `GET /memory/items/{id}/graph` | 501 | P5 |
| `DELETE /memory/items/{id}` | 501 | P5 |

### As of P1

**The Gemini free tier is now the top project risk.** The quota is
`GenerateRequestsPerDayPerProjectPerModel-FreeTier` = **20 requests per day, per model** — per *day*,
not per minute. Development testing exhausted `gemini-3.6-flash` in a single session. Mitigations in
place: chat and extraction run on *different* models so they draw from separate daily buckets, and
backoff handles the per-minute limit. Neither is a fix. Enabling billing on the Google Cloud project
is the only real answer, and it should happen before demo day rather than during it.

**No Pro model is reachable on this key** — every Pro variant returns 429 on first call, verified on
retry. `CLAUDE.md`'s Flash/Pro split is therefore not implemented: chat runs on Flash. This is one
env var (`GEMINI_CHAT_MODEL`) away from being restored if billing is enabled.

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
- **No Gemini call has been made yet.** The key loads from `.env` and `/health` reports
  `gemini_key_loaded`, but that only proves a non-empty string was read — it is not a validated key.
  First real call is P1. Safety-threshold testing against the demo script (CLAUDE.md) is still open,
  and is the item most likely to bite late.
- **No embeddings are written.** The `vector(768)` column and its HNSW index exist and are empty.
  Retrieval is not implemented, so nothing is being ranked by similarity yet.
- **`POST /memory/items` is a direct insert, not extraction.** It exists for tests and manual entry.
  P1 makes extraction the primary path; this route stays as the escape hatch.
- **No auth.** Single seeded demo user, id hardcoded in `.env`. Every route reads `DEMO_USER_ID`
  rather than a session. Fine for the demo, would not survive contact with a second user.
- **No cascade delete, no tombstone handling.** `deleted_at` exists on the table and every read path
  already filters on it, but nothing sets it yet.
