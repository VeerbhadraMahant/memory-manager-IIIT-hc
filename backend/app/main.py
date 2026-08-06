from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import pool
from app.routers import chats, memory


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open()
    pool.wait(timeout=20)
    yield
    pool.close()


app = FastAPI(
    title="Negotiated AI Memory",
    description="Memory the user negotiates, rather than memory that accumulates silently.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chats.router)
app.include_router(memory.router)


@app.get("/health", tags=["meta"])
def health():
    """Also reports whether pgvector is live — the one dependency that fails silently
    until the first embedding insert, which would be during a demo."""
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("select extversion from pg_extension where extname = 'vector'")
        row = cur.fetchone()
        cur.execute("select count(*) as n from memory_items where deleted_at is null")
        n = cur.fetchone()["n"]
    return {
        "status": "ok",
        "pgvector": row["extversion"] if row else None,
        "embedding_dim": settings.embedding_dim,
        "live_memory_items": n,
        "gemini_key_loaded": settings.gemini_api_key is not None,
    }
