"""Sliding-window rate limiting.

Two budgets: a general one, and a much tighter one for routes that spend provider money
(chat, regenerate, draft, anything that embeds). Without the second, one bad client —
or one leaked session — can burn the LLM key for everyone.

State is per-process. With N workers the effective ceiling is N x the setting; that is
acceptable as abuse protection and wrong as a billing guarantee. For hard global limits
put it at the proxy (Cloudflare / nginx `limit_req`) as well — see docs/DEPLOYMENT.md.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request

from app.auth import User, current_user
from app.config import settings

_lock = threading.Lock()
_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_last_sweep = 0.0


def _check(bucket: str, key: str, limit: int, window: float = 60.0) -> None:
    global _last_sweep
    now = time.monotonic()
    with _lock:
        q = _hits[(bucket, key)]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            retry = max(1, int(window - (now - q[0])) + 1)
            raise HTTPException(429, "rate limit exceeded", headers={"Retry-After": str(retry)})
        q.append(now)
        if now - _last_sweep > 300:  # drop idle keys so the dict cannot grow forever
            _last_sweep = now
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > window]:
                del _hits[k]


def reset() -> None:
    with _lock:
        _hits.clear()


def general_limit(request: Request, user: User = Depends(current_user)) -> None:
    _check("general", str(user.id), settings.rate_limit_per_minute)


def llm_limit(request: Request, user: User = Depends(current_user)) -> None:
    _check("llm", str(user.id), settings.rate_limit_llm_per_minute)


def ip_limit(request: Request) -> None:
    """For unauthenticated endpoints (sign-in): keyed by client address."""
    _check("ip", request.client.host if request.client else "unknown", 20)


def spend_llm(user: User) -> None:
    """Charge the LLM budget from inside a handler, for routes that only sometimes
    reach a provider (an edit that does not change the text does not embed)."""
    _check("llm", str(user.id), settings.rate_limit_llm_per_minute)
