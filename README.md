# Negotiated AI Memory

A chat interface where AI memory is **negotiated by the user rather than accumulated silently**.
Users see what is being remembered as it forms, correct it, scope it to a session, and see which
memories shaped each response.

HCI hackathon project (SIGCHI-supported). Design rationale is a first-class deliverable; the
architecture notes, phase plan and decision log are kept alongside this repo rather than in it.

**Current phase: P0, P1, P2, P3 and P6 complete** — the whole demo spine. Say something, get a reply
that shows which memories shaped it, correct the classification in one tap, drop a memory and watch
the answer change, and ask for a high-stakes draft that refuses to write up unfinished work as
finished. Remaining: P4 (complete list view), P7 (pre-send PII), P5 (deletion-preview graph),
P8 (accessibility pass).

The design principles this is judged on are enforced in code, not just described — the table under
[Layout](#where-the-design-principles-actually-live) names the file each one lives in.

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
This key also does extraction and embeddings, so it is effectively required.

`GROQ_API_KEY` and `GEMINI_API_KEY` are optional. Whichever are present appear in the composer's
**Model** switcher, changeable mid-conversation. Switching changes only who writes the next reply —
extraction and embeddings stay pinned, so the memory carries across providers rather than being
re-derived (D32). Each reply is labelled with the model that wrote it.

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
.venv/Scripts/python backend/scripts/smoke_p0.py               # schema + API, no LLM calls
.venv/Scripts/python backend/scripts/smoke_p1.py               # 26 checks, the full loop
.venv/Scripts/python backend/scripts/leak_test_p3.py --no-llm  # store invariants, free
.venv/Scripts/python backend/scripts/leak_test_p3.py           # 18 checks, full leak test
.venv/Scripts/python backend/scripts/smoke_p2_p6.py --no-llm   # classifier truth tables, free
.venv/Scripts/python backend/scripts/smoke_p2_p6.py            # + CV failure case, revoke, decay
.venv/Scripts/python backend/scripts/migrate.py --status
curl http://127.0.0.1:8000/health
```

`smoke_p1.py` makes real LLM calls and draws against the daily free-tier allowance.
Run it when you have changed the loop, not as a habit.

The two `--no-llm` modes are the ones to run in front of an audience: they are free, deterministic,
and they carry the strongest evidence. `leak_test_p3 --no-llm` is a database query returning zero
rows; `smoke_p2_p6 --no-llm` walks the overstatement detector across its whole truth table —
including the row where a draft claims a paper is finished and the memory says otherwise, which the
end-to-end run cannot reach because the model declines to overstate when asked to (D34).

After changing the embedding model — including the Gemini → OpenRouter port — re-embed the store:

```bash
.venv/Scripts/python backend/scripts/reembed.py --dry-run   # report only
.venv/Scripts/python backend/scripts/reembed.py             # rewrites the embedding column only
```

Embeddings from different providers occupy different vector spaces and **mixing them fails
silently** — retrieval returns the wrong memories rather than erroring (D31).

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
      chats.py        chats, messages, the full turn, candidates, regenerate, verified draft
      memory.py       memory items, blocks, filters, accept/reject/edit/rescope/confirm
    services/
      llm.py          three chat providers, extraction, verified draft, embeddings, backoff
      classify.py     heuristic cross-check; the overstatement detector, as a pure function
      policy.py       interruption budget, restrictive fallback, session default
      extraction.py   post-turn pass; enforces the ephemeral skip
      retrieval.py    similarity + scope + review-state filter + staleness
  migrations/         001 schema, 002 seed, 003 extraction status, 004 review reason
  scripts/
    migrate.py        apply .sql files once each, transactionally
    smoke_p0.py       P0 acceptance check
    smoke_p1.py       P1 acceptance check (makes real LLM calls)
    smoke_p2_p6.py    P2/P6 acceptance; --no-llm walks the classifier truth tables
    leak_test_p3.py   P3 scope guarantees; --no-llm is the store-level half
    reembed.py        re-embed the store after an embedding-model change
frontend/
  app/page.tsx        chat, attribution, composer (off-the-record, model, high-stakes)
  components/
    ReviewCard.tsx    inline negotiation UI, one-tap reclassification
    DraftPanel.tsx    high-stakes draft with per-claim verification
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
| Unfinished work never written up as finished | `routers/chats.py` `verified_draft`, in Python |
| Regex may raise sensitivity, never lower it | `services/classify.py` — `raise_sensitivity` |
| Warnings stay credible | `services/classify.py` ranks, `chats.py` most-complete-source rule |

The memory vocabulary (`assertion_status`, `scope`, `sensitivity`, …) appears in three places:
`001_init.sql` as Postgres enums, `models.py` as Pydantic enums, `lib/api.ts` as TypeScript unions.
That duplication is deliberate — a rename should be a visible three-file change, not silent drift.

## Notes for demo day

- The DB is remote. If venue wifi lacks IPv6, swap `DATABASE_URL` to the Supabase **session pooler**
  string — a one-line `.env` edit, worth testing *before* you need it.
- Supabase's SQL editor is a useful demo prop for P3: querying `memory_items` live and returning
  zero rows is stronger evidence that a session-only fact never persisted than any UI claim.
