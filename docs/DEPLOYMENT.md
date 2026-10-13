# Deployment

## 1. Activate Supabase

The app only needs **Postgres** (with pgvector) and, optionally, **Supabase Auth**. It connects
to the database directly; it never calls Supabase's REST API.

1. Create the project. Database → Extensions → enable **vector** (the first migration also runs
   `create extension if not exists vector`).
2. Project → **Connect** → copy a connection string:
   * *Direct* if your host has IPv6, otherwise the **Session pooler** (port 5432).
   * The *Transaction pooler* (port 6543) also works if you set `DB_DISABLE_PREPARED_STATEMENTS=true`.
   * Append `?sslmode=require`.
3. Put it in `DATABASE_URL` (as a secret — see `docs/TEE.md`), then apply the schema:
   ```bash
   RUN_MIGRATIONS=true   # the container does this on start, under an advisory lock
   # or by hand:
   python backend/scripts/migrate.py            # --status to inspect
   ```
4. **Row-level security.** Migration `008` enables RLS on every table with no policies and
   revokes the `anon` / `authenticated` grants. Supabase exposes `public` tables over a REST API
   to anyone holding the (public) anon key; without this the entire memory store would be
   readable from a browser. The backend is unaffected because it connects as the table-owning
   `postgres` role, which bypasses RLS. **Do not** connect the backend as a non-owner role without
   `BYPASSRLS`, or every query will return zero rows.
5. Auth (choose one; `AUTH_REQUIRED=true` is mandatory in production):
   * **Supabase Auth** — enable Google (or any) provider in the dashboard. New projects use
     asymmetric JWT signing: set `SUPABASE_URL=https://<ref>.supabase.co`. Legacy projects: set
     `SUPABASE_JWT_SECRET` (Project Settings → API → JWT secret). The frontend sends
     `Authorization: Bearer <supabase access_token>`. First sight of a user id creates their
     account and the nine default blocks.
   * **Google Identity Services** — set `GOOGLE_CLIENT_ID` and `SESSION_SECRET`; the frontend posts
     the Google ID token to `POST /auth/google` and receives a session token (also set as an
     HttpOnly cookie). `GET /auth/config` tells the frontend which is enabled.
   **Frontend side** — the UI asks the backend (`GET /auth/config`) what is required, so there is
   nothing to hard-code:
   * `auth_required=false` → the app opens straight away as the demo user (no sign-in screen).
   * Supabase → set `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the frontend and, in the Supabase dashboard,
     add your frontend URL to *Authentication → URL Configuration* (Site URL and Redirect URLs) and
     enable the Google provider. Sessions use PKCE and auto-refresh; each request carries
     `Authorization: Bearer <access_token>`.
   * Google → no frontend env needed; the button comes from `GOOGLE_CLIENT_ID`. Add the frontend
     origin to the OAuth client's *Authorized JavaScript origins*. The session is an HttpOnly cookie
     (`credentials: "include"`), so no credential is readable from JavaScript. If the frontend and
     API are on different *sites* (not just ports), set `SESSION_COOKIE_SAMESITE=none` on the API,
     which also forces `Secure`.
   * Supabase wins if both are configured and the anon key is set; a 401 at any time returns the
     user to the sign-in screen.
6. Migration `002` creates a shared demo user. In production it is unreachable (auth is
   required); delete it if you prefer: `delete from users where handle = 'demo';`.

## 2. Configure

All settings are environment variables; `.env.example` documents each. Production is validated at
boot and the process **refuses to start** if: auth is not required, no identity provider is
configured, CORS contains `*`, there is no LLM key, a provider URL is not `https://`, or Google
sign-in is enabled without a ≥ 32-character `SESSION_SECRET`.

## 3. Run

```bash
# local, disposable Postgres
docker compose up --build              # API on :8000, docs at /docs

# production shape (secrets as files, read-only fs, caps dropped)
cp -r deploy/secrets ...               # fill the files, see deploy/secrets/README.md
CORS_ORIGINS=https://app.example.com TRUSTED_HOSTS=api.example.com APP_URL=https://app.example.com \
  docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Put a TLS-terminating reverse proxy in front (the container binds `127.0.0.1:8000`), and set
`FORWARDED_ALLOW_IPS` to its address so rate limiting sees real client IPs.

## 4. Operate

| Endpoint | Use |
|---|---|
| `GET /healthz` | liveness (no DB) — container `HEALTHCHECK` |
| `GET /readyz` | readiness (DB answers) — load balancer target |
| `GET /health` | pgvector version, embedding dim, whether a key is loaded (frontend uses this) |
| `GET /tee` | confidential-compute detection (no secrets) |
| `GET /me/export`, `DELETE /me` | data portability and true account erasure |

* Logs are JSON on stdout (`LOG_JSON=true`), one access line per request with `request_id`; query
  strings are never logged and secrets are redacted.
* Rate limits are **per process** (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_LLM_PER_MINUTE`). With N
  workers the ceiling is N×; add `limit_req` / a WAF at the proxy for a hard global cap.
* Extraction runs as an in-process background task. A restart mid-extraction marks that message
  `failed` at next boot (the UI shows the failure and the user can resend) rather than leaving it
  spinning.
* Embeddings: changing `LLM_EMBED_MODEL` requires `scripts/reembed.py` (vector spaces differ).

## 5. Test

```bash
make install && make db && make test     # real Postgres+pgvector, LLM mocked
make lint
```
CI (`.github/workflows/ci.yml`) runs lint, the test suite against a pgvector service container,
builds the image, and boots it against that database.
