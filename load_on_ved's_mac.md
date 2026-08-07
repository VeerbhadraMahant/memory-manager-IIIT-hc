# Setup on macOS

Everything in the main `README.md` still applies — this file only exists because its shell
commands are Windows-flavored (`.venv/Scripts/python`) and there are a few macOS-specific
gotchas worth knowing up front rather than hitting cold.

## Prerequisites

```bash
brew install python@3.11 node@20 git
```

Check versions — needs Python 3.11+, Node 20+:

```bash
python3 --version
node --version
```

If `python3` resolves to something older (macOS ships an ancient system Python), use the
brewed one explicitly: `/opt/homebrew/bin/python3.11` (Apple Silicon) or
`/usr/local/bin/python3.11` (Intel).

## Get the repo

```bash
git clone <repo-url> IIIT-Sigichai-HC-Repo
cd IIIT-Sigichai-HC-Repo
```

## Environment file

```bash
cp .env.example .env
```

Fill in `.env`:

- **`DATABASE_URL`** — Supabase dashboard → your project → **Connect**. Grab the **Session
  pooler** string (username becomes `postgres.<project-ref>`), not Direct connection.
  ```
  postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
  ```
  **Use the pooler even though macOS generally has working IPv6.** The Direct connection host
  is IPv6-only on Supabase's free tier, and whether it actually routes depends on the network
  (home wifi, campus wifi, a hotspot) more than the OS. We hit this exact failure — DNS resolves
  the direct host to an IPv6 address, then the connection just hangs or errors — on a network
  that should have supported it. The pooler works everywhere and costs nothing. If you want to
  try Direct anyway: `nslookup db.<project-ref>.supabase.co` should return an address, and
  `psql "<direct-url>" -c 'select 1'` should actually connect — don't assume, test it.
  Transaction pooler will not work here — it breaks the prepared statements `psycopg` uses.

- **`LLM_API_KEY`** — https://openrouter.ai/keys. This project talks to OpenRouter, not Gemini —
  ignore anything that mentions `GEMINI_API_KEY`, that's stale from before the port (see
  `DECISION_LOG.md` D29 if curious why). Get any key from the link above; the free tier is fine
  to start.

- Leave `DEMO_USER_ID` and `NEXT_PUBLIC_API_BASE` as the defaults in `.env.example`.

## Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r backend/requirements.txt
```

**If `psycopg[binary]` fails to build** (mainly older Intel Macs, or Python installed a weird
way): it wants a prebuilt wheel and doesn't always find one. Try:
```bash
brew install postgresql@16
pip install --no-binary :all: "psycopg[pool]>=3.2"
```
or switch to a brewed Python 3.11 if you're on a pyenv/conda install that's missing wheels for
your platform.

Apply schema + seed:

```bash
python backend/scripts/migrate.py
python backend/scripts/migrate.py --status   # confirm it applied
```

## Frontend

```bash
cd frontend
npm install
cd ..
```

## Run — two terminals, both from the repo root

```bash
# terminal 1 — API on :8000, docs at /docs
source .venv/bin/activate
cd backend && python -m uvicorn app.main:app --reload --port 8000
```

```bash
# terminal 2 — UI on :3000
cd frontend && npm run dev
```

If port 8000 or 3000 is already taken (common if something else on your machine grabbed it):
```bash
lsof -i :8000        # find what's holding it
kill <pid>           # or pass --port 8001 / -p 3001 to the run commands above
```

## Verify it's actually working

```bash
source .venv/bin/activate
curl http://127.0.0.1:8000/health
```

Expect something like:
```json
{"status":"ok","pgvector":"0.8.2","embedding_dim":768,"live_memory_items":N,"llm_key_loaded":true}
```

- `pgvector` present and non-null → DB connection is good.
- `llm_key_loaded: true` → a key was read from `.env` (this does **not** mean the key is valid —
  it only proves the string is non-empty).

Then the free checks (no LLM calls, no cost):

```bash
python backend/scripts/smoke_p0.py                     # schema + API
python backend/scripts/leak_test_p3.py --no-llm         # store invariants
```

Then open http://localhost:3000, send a message, and confirm you get a real reply (not an
error banner in the chat). That's the first thing that actually exercises the LLM key — if it's
going to fail, this is where you'll see it, with the real error message from OpenRouter shown
inline in the UI.

## Things likely to actually be the problem

1. **DB connection hangs or fails to resolve host** → you're on the Direct connection string.
   Switch to the Session pooler string above.
2. **Chat sends but comes back with an error banner** → check the exact error text in the UI
   first, it's usually specific (auth failure, model not found, rate limited). A `401` means the
   OpenRouter key is wrong; a `404` on a model means a `:free` slug got retired — see
   `backend/app/config.py` for the current `llm_chat_model` / `llm_extract_model` and swap to
   another slug from https://openrouter.ai/models if needed.
3. **`ModuleNotFoundError` on backend start** → the venv isn't activated in that terminal, or
   `pip install` ran against the wrong Python. Confirm with `which python` — it should point
   inside `.venv/bin/`.
4. **Frontend can't reach the backend** (network errors in the browser console) → check
   `NEXT_PUBLIC_API_BASE` in `.env` matches where uvicorn actually printed it's listening
   (`http://127.0.0.1:8000` by default), and that both terminals are actually still running.
5. **`command not found: python`** → macOS's default is `python3`; either use `python3`
   throughout or activate the venv first, which aliases `python` correctly inside it.
