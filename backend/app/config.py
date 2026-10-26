from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from pydantic import PrivateAttr, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from app import secrets as secret_store

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # development: permissive defaults, demo user allowed.
    # production: validated hard at boot (see `_production_rules`) — the process refuses
    # to start misconfigured rather than serving traffic insecurely.
    environment: Literal["development", "test", "production"] = "development"

    # Every credential is a SecretStr: it renders as ********** in repr/logs/tracebacks
    # and is unwrapped only where it is placed on the wire. Each can be supplied as
    # NAME, NAME_FILE or $SECRETS_DIR/name — see app/secrets.py for the TEE rationale.
    database_url: SecretStr

    llm_api_key: SecretStr | None = None

    # OpenRouter speaks the OpenAI-compatible API. Point this at any other
    # OpenAI-compatible gateway and nothing else in the codebase needs to change.
    llm_base_url: str = "https://openrouter.ai/api/v1"

    # Extraction gets the stronger model deliberately. Status classification
    # (in_progress vs. completed) is the field the whole design rests on, and it runs
    # off the critical path where the extra second costs nothing. Verified on the
    # tense test ("still writing" -> in_progress, "finish next month" -> planned).
    # The :free nemotron slug still listed but its upstream function was gone (404 from
    # Nvidia), so extraction failed on every turn. Paid haiku costs ~$0.0001 a call, passes
    # the tense test, and honours strict json_schema.
    llm_extract_model: str = "anthropic/claude-haiku-5.5"

    # Chat is what the user waits on, so it gets the faster model rather than the
    # best one. This is an MoE with few active params — quick, and it passed the
    # same tense test. Point both at paid slugs (drop the `:free` suffix) if the
    # daily free-tier limit becomes the binding constraint on demo day.
    llm_chat_model: str = "google/gemma-4-26b-a4b-it:free"

    # No free embedding model exists on OpenRouter; this one is paid but costs
    # ~$0.02/1M tokens, i.e. fractions of a cent for a whole demo. It is natively
    # 1536-dim and truncated to embedding_dim via the `dimensions` request param,
    # so the column below stays vector(768) and no migration is needed.
    #
    # **This is deliberately NOT switchable at runtime** (D32). Embeddings from
    # different providers occupy different vector spaces, so a mid-session switch
    # would silently fragment the store — the exact failure D31 exists to prevent.
    # The chat model changes; what the memory *is* does not.
    llm_embed_model: str = "openai/text-embedding-3-small"

    # ---------------------------------------------------------------- chat providers
    # Additional providers for the runtime chat switcher (D32). Extraction and
    # embeddings stay pinned above regardless of which of these answers a turn —
    # the whole point is that memory is provider-independent.

    gemini_api_key: SecretStr | None = None
    # gemini-2.5-flash is listed by the API but returns "no longer available to new
    # users" on a new key; 3.6-flash is the newest that actually answers, and is on
    # the same free tier. Free-tier Gemini is 20 requests/day/model — fine for
    # demonstrating a switch, not for sustained use.
    gemini_chat_model: str = "gemini-3.6-flash"

    groq_api_key: SecretStr | None = None
    # Qwen is a reasoning model and emits <think>...</think> in the content; llm.py
    # strips those rather than showing the user the model's scratchpad.
    # qwen3.6-27b was retired from Groq (404); 3.8 is its successor and answers.
    groq_chat_model: str = "qwen/qwen3.8-27b"
    groq_base_url: str = "https://api.groq.com/openai/v1"

    # Which provider answers when the client does not ask for one.
    # Groq, because qwen3 is the only configured chat model that emits a <think>
    # block — and the reasoning panel shows the model's real scratchpad or nothing
    # at all, never a synthesised one. On OpenRouter's gemma or Gemini flash the
    # panel is simply absent, which is correct but makes the feature invisible.
    # Override with DEFAULT_CHAT_PROVIDER if Groq's daily limit runs out; resolve_provider
    # falls back on its own if the key is missing entirely.
    default_chat_provider: str = "groq"

    # Seeded by migration 002, and still the request identity for every route —
    # there are 24 call sites reading it and no auth dependency to replace them yet.
    # (An earlier version of this comment said otherwise, pointing at a deps.py and
    # routers/auth.py that do not exist. Corrected rather than left, because a
    # comment claiming the app is multi-user when it is not is the kind of thing
    # that gets believed.)
    demo_user_id: UUID = UUID("00000000-0000-0000-0000-000000000001")

    # ---------------------------------------------------------------- auth
    # When false, every request acts as `demo_user_id` (local dev, the hackathon demo).
    # When true, a request must carry a verified identity or it gets 401. Production
    # forces this on.
    auth_required: bool = False

    # Supabase Auth. Set SUPABASE_URL for asymmetric (JWKS) verification — what current
    # Supabase projects use — or SUPABASE_JWT_SECRET for legacy HS256 projects. Neither
    # needs the service-role key; this backend never calls Supabase's REST API, it
    # connects to Postgres directly.
    supabase_url: str | None = None
    supabase_jwt_secret: SecretStr | None = None
    supabase_service_role_key: SecretStr | None = None  # reserved; unused today

    # Google Identity Services. The browser posts a Google ID token to POST /auth/google;
    # it is verified against this client id (never trusting the token's own `aud`) and
    # exchanged for a signed session token.
    google_client_id: str | None = None

    # Signs the session token/cookie issued by /auth/google. Must be a long random
    # value in production (>= 32 chars). Optional elsewhere so /health still answers on
    # a checkout that has not set it.
    session_secret: SecretStr | None = None
    session_cookie_name: str = "nam_session"
    session_max_age_days: int = 30
    # SameSite=None requires Secure; use it only when the frontend and API are on
    # different sites. Lax is right for same-site deployments.
    session_cookie_samesite: Literal["lax", "strict", "none"] = "lax"

    # Public URL of this app, sent to OpenRouter as HTTP-Referer for traffic attribution.
    app_url: str = "http://localhost:3000"

    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    # Host header allow-list. Empty = off (dev). In production set to your API hostname(s).
    trusted_hosts: Annotated[list[str], NoDecode] = []
    docs_enabled: bool | None = None  # /docs and /openapi.json; None = on except in production

    # ---------------------------------------------------------------- operations
    log_level: str = "INFO"
    log_json: bool = False
    # Requests per rolling minute, per user (or per client IP when unauthenticated).
    # `rate_limit_llm_per_minute` guards routes that spend provider money.
    rate_limit_per_minute: int = 240
    rate_limit_llm_per_minute: int = 30
    max_request_bytes: int = 256 * 1024

    db_pool_min: int = 1
    db_pool_max: int = 10
    db_pool_timeout_s: float = 15.0
    db_statement_timeout_ms: int = 30_000
    # Supabase "transaction" pooler (port 6543) cannot run server-side prepared
    # statements. Set true when DATABASE_URL points at it.
    db_disable_prepared_statements: bool = False

    # Extraction rows still 'pending' after this long belong to a process that died.
    extraction_stale_after_s: int = 300

    # Refuse to boot unless a confidential-compute guest interface is visible.
    require_tee: bool = False

    # P6 decay. An in_progress item unconfirmed for longer than this is treated as
    # stale: still usable, but never asserted as current without a re-check. Two weeks
    # is a guess tuned for a demo, not a finding — say so if asked. Set it to 0 to make
    # everything stale, which is how the decay path gets demonstrated without waiting.
    stale_after_days: int = 14

    # Embedding dimension is duplicated in migrations/001_init.sql as vector(768).
    # If you change one, the other breaks loudly at insert time — which is the point.
    embedding_dim: int = 768


    _secrets_from_files: list[str] = PrivateAttr(default_factory=list)

    @property
    def secrets_from_files(self) -> list[str]:
        return self._secrets_from_files

    # ---------------------------------------------------------------- validation

    @field_validator("cors_origins", "trusted_hosts", mode="before")
    @classmethod
    def _csv_or_json(cls, v):
        """Accept `a,b` as well as `["a","b"]` — the former is what compose/k8s env
        blocks naturally produce."""
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                import json

                return json.loads(v)
            return [p.strip() for p in v.split(",") if p.strip()]
        return v

    @model_validator(mode="after")
    def _production_rules(self) -> Settings:
        if self.environment != "production":
            return self
        problems: list[str] = []
        if not self.auth_required:
            problems.append("AUTH_REQUIRED must be true (the demo user is not reachable in production)")
        if not (self.supabase_url or self.supabase_jwt_secret or self.google_client_id):
            problems.append("configure an identity provider: SUPABASE_URL / SUPABASE_JWT_SECRET / GOOGLE_CLIENT_ID")
        if self.google_client_id and (
            not self.session_secret or len(self.session_secret.get_secret_value()) < 32
        ):
            problems.append("SESSION_SECRET must be at least 32 characters when Google sign-in is enabled")
        if "*" in self.cors_origins:
            problems.append("CORS_ORIGINS must not contain '*'")
        if not self.llm_api_key:
            problems.append("LLM_API_KEY is required (extraction and embeddings use it)")
        for name in ("llm_base_url", "groq_base_url"):
            if not getattr(self, name).startswith("https://"):
                problems.append(f"{name.upper()} must use https:// so provider keys never cross the wire in clear")
        if problems:
            raise ValueError("unsafe production configuration:\n  - " + "\n  - ".join(problems))
        return self

    # ---------------------------------------------------------------- accessors
    # Unwrap secrets in exactly one place each, so grep for these names finds every
    # point where a raw credential is handled.

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def dsn(self) -> str:
        return self.database_url.get_secret_value()

    @property
    def llm_key(self) -> str | None:
        return self.llm_api_key.get_secret_value() if self.llm_api_key else None

    @property
    def groq_key(self) -> str | None:
        return self.groq_api_key.get_secret_value() if self.groq_api_key else None

    @property
    def gemini_key(self) -> str | None:
        return self.gemini_api_key.get_secret_value() if self.gemini_api_key else None


def _load() -> Settings:
    overrides = secret_store.load_secret_overrides()
    s = Settings(**overrides)  # type: ignore[call-arg]
    secret_store.register_secret_values(
        [
            v.get_secret_value()
            for v in (
                s.database_url, s.llm_api_key, s.groq_api_key, s.gemini_api_key,
                s.session_secret, s.supabase_jwt_secret, s.supabase_service_role_key,
            )
            if v is not None
        ]
    )
    secret_store.register_secret_values([_password_of(s.dsn)])
    s._secrets_from_files = sorted(overrides)
    secret_store.scrub_environment()
    return s


def _password_of(dsn: str) -> str:
    """The password component of a Postgres URL, so it is redacted on its own."""
    from urllib.parse import urlsplit

    try:
        return urlsplit(dsn).password or ""
    except ValueError:
        return ""


settings = _load()
