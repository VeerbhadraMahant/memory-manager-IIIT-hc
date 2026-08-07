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

    llm_api_key: str | None = None

    # OpenRouter speaks the OpenAI-compatible API. Point this at any other
    # OpenAI-compatible gateway and nothing else in the codebase needs to change.
    llm_base_url: str = "https://openrouter.ai/api/v1"

    # Extraction gets the stronger model deliberately. Status classification
    # (in_progress vs. completed) is the field the whole design rests on, and it runs
    # off the critical path where the extra second costs nothing. Verified on the
    # tense test ("still writing" -> in_progress, "finish next month" -> planned).
    llm_extract_model: str = "nvidia/nemotron-3-super-120b-a12b:free"

    # Chat is what the user waits on, so it gets the faster model rather than the
    # best one. This is an MoE with few active params — quick, and it passed the
    # same tense test. Point both at paid slugs (drop the `:free` suffix) if the
    # daily free-tier limit becomes the binding constraint on demo day.
    llm_chat_model: str = "google/gemma-4-26b-a4b-it:free"

    # No free embedding model exists on OpenRouter; this one is paid but costs
    # ~$0.02/1M tokens, i.e. fractions of a cent for a whole demo. It is natively
    # 1536-dim and truncated to embedding_dim via the `dimensions` request param,
    # so the column below stays vector(768) and no migration is needed.
    llm_embed_model: str = "openai/text-embedding-3-small"

    # Seeded by migration 002. No auth flow during the hackathon; swapping this for
    # a real user id later touches only the request-scoped dependency in deps.py.
    demo_user_id: UUID = UUID("00000000-0000-0000-0000-000000000001")

    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Embedding dimension is duplicated in migrations/001_init.sql as vector(768).
    # If you change one, the other breaks loudly at insert time — which is the point.
    embedding_dim: int = 768


settings = Settings()  # type: ignore[call-arg]
