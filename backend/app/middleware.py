"""Pure-ASGI middleware: request ids, access logging, body-size cap, security headers.

Pure ASGI rather than Starlette's BaseHTTPMiddleware, which buffers responses and runs
the endpoint in a separate task — both unwelcome for a service whose slow requests are
LLM calls.
"""

from __future__ import annotations

import logging
import time
import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("app.access")

SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-site",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    # An API serves JSON, never documents; this forbids anything being rendered.
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    # Responses carry personal memory. Nothing here should sit in a shared cache.
    "cache-control": "no-store",
}


class RequestContext:
    """Assigns `X-Request-ID`, logs one access line per request, adds security headers."""

    def __init__(self, app: ASGIApp, *, hsts: bool = False, docs_paths: tuple[str, ...] = ()):
        self.app = app
        self.hsts = hsts
        self.docs_paths = docs_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        incoming = headers.get(b"x-request-id", b"").decode("latin-1")
        # Accept a caller-supplied id only if it is short and benign; it is echoed into logs.
        rid = incoming if 8 <= len(incoming) <= 64 and incoming.replace("-", "").isalnum() else uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = rid
        start = time.perf_counter()
        status = 500
        path = scope["path"]
        is_docs = path in self.docs_paths

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                h = MutableHeaders(scope=message)
                h["x-request-id"] = rid
                for k, v in SECURITY_HEADERS.items():
                    if is_docs and k in ("content-security-policy", "cache-control"):
                        continue  # Swagger UI needs inline scripts/CDN assets
                    h.setdefault(k, v)
                if self.hsts:
                    h.setdefault("strict-transport-security", "max-age=31536000; includeSubDomains")
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            # Path only — never the query string, which is where tokens and search
            # text can end up.
            if path not in ("/healthz", "/readyz"):
                log.info(
                    "%s %s -> %s",
                    scope["method"], path, status,
                    extra={"request_id": rid, "duration_ms": round((time.perf_counter() - start) * 1000, 1)},
                )


class BodySizeLimit:
    """Reject oversized request bodies before they are parsed.

    Checks Content-Length up front, and counts bytes as they stream for requests that
    omit it (chunked), so the cap cannot be bypassed by dropping the header.
    """

    def __init__(self, app: ASGIApp, *, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = dict(scope["headers"]).get(b"content-length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(send)
            return

        received = 0
        too_big = False

        async def limited_receive() -> Message:
            nonlocal received, too_big
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    too_big = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        started = False

        async def guarded_send(message: Message) -> None:
            nonlocal started
            if too_big and not started:
                started = True
                await self._reject(send)
                return
            if too_big:
                return
            started = started or message["type"] == "http.response.start"
            await send(message)

        await self.app(scope, limited_receive, guarded_send)

    async def _reject(self, send: Send) -> None:
        body = b'{"detail":"request body too large"}'
        await send({
            "type": "http.response.start", "status": 413,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
