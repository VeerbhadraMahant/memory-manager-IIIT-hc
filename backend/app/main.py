from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import pool
from app.logging_setup import configure_logging
from app.middleware import BodySizeLimit, RequestContext
from app.routers import account, auth, chats, memory
from app.secrets import tee_status
from app.services import llm

configure_logging()
log = logging.getLogger(__name__)

DOCS_ON = settings.docs_enabled if settings.docs_enabled is not None else not settings.is_production


def _sweep_interrupted_extractions() -> int:
    """Mark extraction passes orphaned by a restart as failed.

    Extraction runs as an in-process background task. If the process dies mid-pass the
    message stays 'pending' forever and the UI spins on it (migration 003's comment
    anticipates exactly this). Anything still pending past the threshold at boot
    belongs to a previous process.
    """
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """update messages
                  set extraction_status = 'failed',
                      extraction_error = 'interrupted by a server restart — send the message again'
                where extraction_status = 'pending'
                  and created_at < now() - make_interval(secs => %s)
            returning id""",
            (settings.extraction_stale_after_s,),
        )
        return len(cur.fetchall())


@asynccontextmanager
async def lifespan(app: FastAPI):
    tee = tee_status(settings.secrets_from_files)
    if settings.require_tee and not tee["detected"]:
        raise RuntimeError(
            "REQUIRE_TEE=true but no confidential-compute guest interface was found "
            "(/dev/sev-guest, /dev/tdx_guest, /dev/nsm, dstack socket, ...). Refusing to "
            "start with secrets outside a trusted execution environment."
        )
    log.info(
        "starting env=%s auth_required=%s tee=%s secrets_from_files=%s",
        settings.environment, settings.auth_required, tee["type"] or "none", tee["secrets_from_files"],
    )
    if settings.environment == "development" and not settings.auth_required:
        log.warning("AUTH_REQUIRED=false: every request acts as the shared demo user")

    pool.open()
    pool.wait(timeout=20)
    try:
        swept = _sweep_interrupted_extractions()
    except Exception:
        log.exception("startup sweep of interrupted extractions failed; continuing")
        swept = 0
    if swept:
        log.warning("marked %d interrupted extraction pass(es) as failed", swept)
    yield
    llm.close_clients()
    pool.close()


app = FastAPI(
    title="Negotiated AI Memory",
    description="Memory the user negotiates, rather than memory that accumulates silently.",
    version="1.0.0",
    lifespan=lifespan,
    # Vercel mounts this service at /api and hands us the full path. Starlette strips
    # root_path when present and leaves paths without it alone, so local dev is unchanged.
    root_path="/api",
    docs_url="/docs" if DOCS_ON else None,
    redoc_url=None,
    openapi_url="/openapi.json" if DOCS_ON else None,
)

# Outermost last: request context wraps everything, so even a CORS or size rejection
# carries a request id and security headers.
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,  # the session cookie; origins are an explicit list, never '*'
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID", "Retry-After"],
    max_age=600,
)
if settings.trusted_hosts:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts)
app.add_middleware(BodySizeLimit, max_bytes=settings.max_request_bytes)
app.add_middleware(
    RequestContext,
    hsts=settings.is_production,
    docs_paths=("/docs", "/openapi.json") if DOCS_ON else (),
)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    """Last resort. The detail stays in the (scrubbed) server log; the client gets an
    id to quote, not a stack trace or a driver error naming tables and columns."""
    rid = getattr(request.state, "request_id", None)
    log.exception("unhandled error on %s %s", request.method, request.url.path, extra={"request_id": rid})
    return JSONResponse({"detail": "internal server error", "request_id": rid}, status_code=500)


app.include_router(auth.router)
app.include_router(account.router)
app.include_router(chats.router)
app.include_router(memory.router)


@app.get("/healthz", tags=["meta"], include_in_schema=False)
def healthz():
    """Liveness: the process is up. Touches nothing, so an orchestrator never restarts
    a healthy app because the database blinked."""
    return {"status": "ok"}


@app.get("/readyz", tags=["meta"], include_in_schema=False)
def readyz():
    """Readiness: can serve traffic — the database answers."""
    try:
        with pool.connection(timeout=3) as conn:
            conn.execute("select 1")
    except Exception:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return {"status": "ready"}


@app.get("/health", tags=["meta"])
def health():
    """Also reports whether pgvector is live — the one dependency that fails silently
    until the first embedding insert, which would be during a demo.

    Public, so it reveals nothing about the store: the global memory count it used to
    return is only included while running unauthenticated (single demo user)."""
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("select extversion from pg_extension where extname = 'vector'")
        row = cur.fetchone()
        body = {
            "status": "ok",
            "pgvector": row["extversion"] if row else None,
            "embedding_dim": settings.embedding_dim,
            "llm_key_loaded": settings.llm_key is not None,
            "auth_required": settings.auth_required,
        }
        if not settings.auth_required:
            cur.execute("select count(*) as n from memory_items where deleted_at is null")
            body["live_memory_items"] = cur.fetchone()["n"]
    return body


@app.get("/tee", tags=["meta"])
def tee():
    """Whether this process sees a confidential-compute guest interface, and which
    secrets were loaded from files. Booleans and labels only — no secret material.

    `detected` means the guest device is present; it is not an attestation. Verify the
    platform's attestation quote with your relying party (KMS / secrets broker) before
    trusting the deployment — see docs/TEE.md."""
    return {**tee_status(settings.secrets_from_files), "require_tee": settings.require_tee}
