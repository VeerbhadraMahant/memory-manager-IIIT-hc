from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str

    gemini_api_key: str | None = None

    # Free-tier quota is GenerateRequestsPerDayPerProjectPerModel = 20/day — per DAY,
    # and critically **per model**. Chat and extraction therefore run on different
    # models so they draw from separate buckets, roughly doubling usable turns.
    # This is mitigation, not a fix: enabling billing is the only real answer.
    #
    # Extraction gets the stronger model deliberately. Status classification
    # (in_progress vs. completed) is the field the whole design rests on, and it runs
    # off the critical path where the extra second costs nothing.
    gemini_extract_model: str = "gemini-3.5-flash"

    # Chat is what the user waits on, so it gets the fastest model rather than the
    # best one. CLAUDE.md specifies Pro here; the free-tier key has no Pro quota at
    # all (every variant 429s on first call). Point this at a Pro model if billing is
    # enabled — nothing else in the codebase needs to change.
    gemini_chat_model: str = "gemini-3.1-flash-lite"

    # embedding-001, not embedding-2: only 001 returns one vector per input when given
    # a batch. embedding-2 returns a single embedding for a list of five, silently.
    # 001 needs re-normalising at 768 dims, which gemini.embed() does (D10, revised).
    gemini_embed_model: str = "gemini-embedding-001"

    # Seeded by migration 002. No auth flow during the hackathon; swapping this for
    # a real user id later touches only the request-scoped dependency in deps.py.
    demo_user_id: UUID = UUID("00000000-0000-0000-0000-000000000001")

    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Embedding dimension is duplicated in migrations/001_init.sql as vector(768).
    # If you change one, the other breaks loudly at insert time — which is the point.
    embedding_dim: int = 768


settings = Settings()  # type: ignore[call-arg]
