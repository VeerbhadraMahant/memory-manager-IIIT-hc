from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import pool
from app.models import Me
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


@app.get("/me", response_model=Me, tags=["meta"])
def me():
    """Who the request is acting as, for the sidebar's profile entry.

    Reads the `users` row rather than echoing `settings.demo_user_id`, so what the UI
    shows is a fact from the database. There is no sign-in yet, so this is always the
    demo user and `is_demo_user` says so plainly instead of dressing it up as an
    account. When auth lands, this endpoint resolves a session and the frontend needs
    no change.
    """
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "select id, handle, created_at from users where id = %s",
            (settings.demo_user_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(500, "configured demo user does not exist — run migrate.py")
    return Me(**row, is_demo_user=row["id"] == settings.demo_user_id)


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
        "llm_key_loaded": settings.llm_api_key is not None,
    }
