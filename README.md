# Negotiated AI Memory

A chat interface where AI memory is **negotiated by the user rather than accumulated silently**.
Users see what is being remembered as it forms, correct it, scope it to a session, and see which
memories shaped each response.

HCI hackathon project (SIGCHI-supported). Design rationale is a first-class deliverable —
`DECISION_LOG.md` is judging evidence, not bookkeeping.

| Document | What's in it |
|---|---|
| `CLAUDE.md` | Core concepts, design principles, stack rules |
| `SYSTEM_DESIGN.md` | Architecture, data model, endpoints, trade-offs |
| `PHASES.md` | Build phases, current status, **and what is stubbed** |
| `DECISION_LOG.md` | Decisions with their rejected alternatives |

**Current phase: P1 complete** — the core loop runs. Say something in the chat, get a reply that
shows which memories shaped it, and negotiate what gets remembered without leaving the conversation.
See `PHASES.md` for exactly what is and is not built.

> **Read this before you demo.** The Gemini free tier allows **20 requests per day, per model** —
> per *day*. Chat and extraction are split across two models to double that, but a working session
> will exhaust it. Enable billing on the Google Cloud project ahead of demo day.

---

## Setup

Requires Python 3.11+, Node 20+, and a Postgres database with pgvector
(this repo is developed against Supabase free tier).

```bash
cp .env.example .env        # then fill in DATABASE_URL and GEMINI_API_KEY
```

`DATABASE_URL` — Supabase dashboard → **Connect**. Use **Direct connection** if your network has
IPv6, otherwise **Session pooler** (note the username becomes `postgres.<project-ref>`).
Transaction pooler will not work — it breaks the prepared statements psycopg uses.

`GEMINI_API_KEY` — https://aistudio.google.com/apikey

```bash
# backend
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt   # Windows
# .venv/bin/python -m pip install -r backend/requirements.txt     # macOS/Linux

.venv/Scripts/python backend/scripts/migrate.py                   # apply schema + seed

# frontend
cd frontend && npm install
```

## Run

Two terminals:

```bash
# terminal 1 — API on :8000, docs at /docs
cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# terminal 2 — UI on :3000
cd frontend && npm run dev
```

## Verify

```bash
.venv/Scripts/python backend/scripts/smoke_p0.py     # 19 checks, schema + API, no Gemini
.venv/Scripts/python backend/scripts/smoke_p1.py     # 26 checks, the full loop
.venv/Scripts/python backend/scripts/migrate.py --status
curl http://127.0.0.1:8000/health
```

`smoke_p1.py` makes real Gemini calls and costs roughly 4 of your 20 daily requests per model.
Run it when you have changed the loop, not as a habit.

To clear accumulated test memories without touching the schema:

```sql
-- Supabase SQL editor. Blocks and the demo user survive.
delete from attributions;
delete from memory_edges;
delete from audit_log;
delete from memory_items;
delete from messages;
delete from chats;
```

`/health` reports the live pgvector version and the embedding dimension. It also reports
`gemini_key_loaded`, which only means a non-empty string was read from `.env` — it does not
validate the key.

---

## Layout

```
backend/
  app/
    main.py           FastAPI app, CORS, /health
    config.py         env-driven settings, model choices
    db.py             psycopg3 connection pool
    models.py         Pydantic mirrors of the DB vocabulary
    routers/
      chats.py        chats, messages, the full turn, candidate polling
      memory.py       memory items, blocks, filters, accept/reject/edit/rescope
    services/
      gemini.py       client, extraction prompt, chat, embeddings, backoff
      policy.py       interruption budget, restrictive fallback, session default
      extraction.py   post-turn pass; enforces the ephemeral skip
      retrieval.py    similarity + scope + review-state filter
  migrations/         001 schema, 002 seed, 003 extraction status, 004 review reason
  scripts/
    migrate.py        apply .sql files once each, transactionally
    smoke_p0.py       P0 acceptance check
    smoke_p1.py       P1 acceptance check (uses Gemini quota)
frontend/
  app/page.tsx        chat, attribution, composer with off-the-record
  components/
    ReviewCard.tsx    inline negotiation UI
  lib/api.ts          typed client and user-facing labels
```

### Where the design principles actually live

| Principle | Enforced in |
|---|---|
| Session scope is real, not a UI filter | `services/extraction.py` (skip) + `services/retrieval.py` (SQL) |
| Interruption budget | `services/policy.py` — `AUTO_ACCEPT_*` |
| Low confidence → more restrictive block | `services/policy.py` — `TRUST_BLOCK_ABOVE` |
| Sensitive-but-legitimate → session by default | `services/policy.py` — `SESSION_BY_DEFAULT` |
| No orphaned facts | `source_message_id NOT NULL` in `001_init.sql` |
| Consequence, not caution | `components/ReviewCard.tsx` wording, `gemini.py` chat prompt |

The memory vocabulary (`assertion_status`, `scope`, `sensitivity`, …) appears in three places:
`001_init.sql` as Postgres enums, `models.py` as Pydantic enums, `lib/api.ts` as TypeScript unions.
That duplication is deliberate — a rename should be a visible three-file change, not silent drift.

## Notes for demo day

- The DB is remote. If venue wifi lacks IPv6, swap `DATABASE_URL` to the Supabase **session pooler**
  string — a one-line `.env` edit, worth testing *before* you need it.
- Supabase's SQL editor is a useful demo prop for P3: querying `memory_items` live and returning
  zero rows is stronger evidence that a session-only fact never persisted than any UI claim.
