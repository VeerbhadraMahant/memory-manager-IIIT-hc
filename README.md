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

**Current phase: P0, P1 and P3 complete.** The core loop runs — say something, get a reply that shows
which memories shaped it, and negotiate what gets remembered without leaving the conversation — and
session scoping is enforced and demonstrable across sessions. See `PHASES.md` for exactly what is and
is not built.

> **Read this before you demo.** Chat and extraction run on OpenRouter `:free` model slugs, which
> are rate-limited per day and are **retired without notice** — three `:free` slugs 404'd during the
> port. If chat starts failing, check the slug is still listed before debugging anything else, and
> drop the `:free` suffix in `LLM_CHAT_MODEL` / `LLM_EXTRACT_MODEL` to fall back to the paid version.
> Embeddings have no free option, but cost fractions of a cent per session.

---

## Setup

Requires Python 3.11+, Node 20+, and a Postgres database with pgvector
(this repo is developed against Supabase free tier).

```bash
cp .env.example .env        # then fill in DATABASE_URL and LLM_API_KEY
```

`DATABASE_URL` — Supabase dashboard → **Connect**. Use **Direct connection** if your network has
IPv6, otherwise **Session pooler** (note the username becomes `postgres.<project-ref>`).
Transaction pooler will not work — it breaks the prepared statements psycopg uses.

`LLM_API_KEY` — https://openrouter.ai/keys. OpenRouter is reached over its OpenAI-compatible API,
so `LLM_BASE_URL` can point at any other compatible gateway without further code changes.

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
.venv/Scripts/python backend/scripts/smoke_p0.py            # 19 checks, schema + API, no LLM calls
.venv/Scripts/python backend/scripts/smoke_p1.py            # 26 checks, the full loop
.venv/Scripts/python backend/scripts/leak_test_p3.py --no-llm  # store invariants, free
.venv/Scripts/python backend/scripts/leak_test_p3.py        # 18 checks, full leak test
.venv/Scripts/python backend/scripts/migrate.py --status
curl http://127.0.0.1:8000/health
```

`smoke_p1.py` makes real LLM calls and draws against the daily free-tier allowance.
Run it when you have changed the loop, not as a habit.

After changing the embedding model — including the Gemini → OpenRouter port — re-embed the store:

```bash
.venv/Scripts/python backend/scripts/reembed.py --dry-run   # report only
.venv/Scripts/python backend/scripts/reembed.py             # rewrites the embedding column only
```

Embeddings from different providers occupy different vector spaces and **mixing them fails
silently** — retrieval returns the wrong memories rather than erroring (D27).

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
`llm_key_loaded`, which only means a non-empty string was read from `.env` — it does not
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
      llm.py          OpenRouter client, extraction prompt, chat, embeddings, backoff
      policy.py       interruption budget, restrictive fallback, session default
      extraction.py   post-turn pass; enforces the ephemeral skip
      retrieval.py    similarity + scope + review-state filter
  migrations/         001 schema, 002 seed, 003 extraction status, 004 review reason
  scripts/
    migrate.py        apply .sql files once each, transactionally
    smoke_p0.py       P0 acceptance check
    smoke_p1.py       P1 acceptance check (makes real LLM calls)
    reembed.py        re-embed the store after an embedding-model change
frontend/
  app/page.tsx        chat, attribution, composer with off-the-record
  components/
    ReviewCard.tsx    inline negotiation UI
  lib/api.ts          typed client and user-facing labels
```

### Where the design principles actually live

| Principle | Enforced in |
|---|---|
| Session scope is real, not a UI filter | `services/extraction.py` (skip) + `services/retrieval.py` (SQL), proved by `scripts/leak_test_p3.py` |
| Interruption budget | `services/policy.py` — `AUTO_ACCEPT_*` |
| Low confidence → more restrictive block | `services/policy.py` — `TRUST_BLOCK_ABOVE` |
| Sensitive-but-legitimate → session by default | `services/policy.py` — `SESSION_BY_DEFAULT` |
| No orphaned facts | `source_message_id NOT NULL` in `001_init.sql` |
| Consequence, not caution | `components/ReviewCard.tsx` wording, `llm.py` chat prompt |

The memory vocabulary (`assertion_status`, `scope`, `sensitivity`, …) appears in three places:
`001_init.sql` as Postgres enums, `models.py` as Pydantic enums, `lib/api.ts` as TypeScript unions.
That duplication is deliberate — a rename should be a visible three-file change, not silent drift.

## Notes for demo day

- The DB is remote. If venue wifi lacks IPv6, swap `DATABASE_URL` to the Supabase **session pooler**
  string — a one-line `.env` edit, worth testing *before* you need it.
- Supabase's SQL editor is a useful demo prop for P3: querying `memory_items` live and returning
  zero rows is stronger evidence that a session-only fact never persisted than any UI claim.
