"""Request identity.

Replaces the 24 `settings.demo_user_id` call sites with one dependency, `current_user`.

Accepted credentials, in order:

1. A session token issued by `POST /auth/google` (bearer header or cookie).
2. A Supabase Auth access token (bearer header) — verified against the project's JWKS
   (`SUPABASE_URL`) or legacy shared secret (`SUPABASE_JWT_SECRET`).

With `AUTH_REQUIRED=false` an unauthenticated request acts as the demo user, which is how
local development and the original hackathon demo keep working. In production the
settings validator forces `AUTH_REQUIRED=true`, so the demo user is unreachable.

Tokens are verified, not trusted: signature, expiry, issuer and audience are all
checked, and the accepted algorithms are pinned per key type so an attacker cannot
downgrade to `none` or confuse an HS256 secret with an RSA public key.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

from app.config import settings
from app.db import pool
from app.services.users import provision_user

log = logging.getLogger(__name__)

SESSION_ISSUER = "negotiated-ai-memory"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"


@dataclass(frozen=True)
class User:
    id: UUID
    handle: str
    is_demo: bool = False


# --------------------------------------------------------------------- tokens

_jwks_clients: dict[str, PyJWKClient] = {}


def _jwks(url: str) -> PyJWKClient:
    if url not in _jwks_clients:
        # PyJWKClient caches keys and refetches on an unknown `kid`, so key rotation
        # needs no restart.
        _jwks_clients[url] = PyJWKClient(url, cache_keys=True, lifespan=3600, timeout=10)
    return _jwks_clients[url]


def issue_session_token(user_id: UUID) -> str:
    if not settings.session_secret:
        raise HTTPException(503, "sign-in is not configured (SESSION_SECRET is unset)")
    now = int(time.time())
    return jwt.encode(
        {
            "iss": SESSION_ISSUER,
            "sub": str(user_id),
            "iat": now,
            "exp": now + settings.session_max_age_days * 86400,
        },
        settings.session_secret.get_secret_value(),
        algorithm="HS256",
    )


def _verify_session_token(token: str) -> UUID | None:
    if not settings.session_secret:
        return None
    try:
        claims = jwt.decode(
            token,
            settings.session_secret.get_secret_value(),
            algorithms=["HS256"],
            issuer=SESSION_ISSUER,
            options={"require": ["exp", "sub", "iss"]},
        )
        return UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError):
        return None


def _verify_supabase_token(token: str) -> dict | None:
    """Claims of a valid Supabase access token, or None."""
    options = {"require": ["exp", "sub"]}
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        return None
    alg = header.get("alg")

    try:
        if alg == "HS256" and settings.supabase_jwt_secret:
            return jwt.decode(
                token,
                settings.supabase_jwt_secret.get_secret_value(),
                algorithms=["HS256"],
                audience="authenticated",
                options=options,
            )
        if alg in ("ES256", "RS256", "EdDSA") and settings.supabase_url:
            base = settings.supabase_url.rstrip("/")
            key = _jwks(f"{base}/auth/v1/.well-known/jwks.json").get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                key.key,
                algorithms=["ES256", "RS256", "EdDSA"],
                audience="authenticated",
                issuer=f"{base}/auth/v1",
                options=options,
            )
    except (jwt.PyJWTError, OSError) as e:
        log.info("supabase token rejected: %s", type(e).__name__)
    return None


def verify_google_id_token(credential: str) -> dict:
    """Validate a Google Identity Services ID token. Raises 401 on any failure."""
    if not settings.google_client_id:
        raise HTTPException(503, "Google sign-in is not configured (GOOGLE_CLIENT_ID is unset)")
    try:
        key = _jwks(GOOGLE_JWKS_URL).get_signing_key_from_jwt(credential)
        claims = jwt.decode(
            credential,
            key.key,
            algorithms=["RS256"],
            # Checked against *our* client id, never the token's own claim of who it is for.
            audience=settings.google_client_id,
            options={"require": ["exp", "sub", "aud", "iss"]},
        )
    except (jwt.PyJWTError, OSError) as e:
        log.info("google token rejected: %s", type(e).__name__)
        raise HTTPException(401, "invalid Google credential") from e
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise HTTPException(401, "invalid Google credential")
    if not claims.get("email_verified"):
        raise HTTPException(401, "Google account email is not verified")
    return claims


# --------------------------------------------------------------------- dependency

# user ids already provisioned in this process: skips the existence round-trip on the
# hot path. A deleted account is evicted by `forget_user`.
_known: dict[UUID, User] = {}


def forget_user(user_id: UUID) -> None:
    _known.pop(user_id, None)


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return request.cookies.get(settings.session_cookie_name)


def _demo_user() -> User:
    return User(id=settings.demo_user_id, handle="demo", is_demo=True)


def current_user(request: Request) -> User:
    cached = getattr(request.state, "user", None)
    if cached:
        return cached

    token = _bearer(request)
    user: User | None = None

    if token:
        uid = _verify_session_token(token)
        profile: dict = {}
        if uid is None:
            claims = _verify_supabase_token(token)
            if claims:
                try:
                    uid = UUID(claims["sub"])
                except ValueError:
                    uid = None
                meta = claims.get("user_metadata") or {}
                profile = {
                    "email": claims.get("email"),
                    "name": meta.get("full_name") or meta.get("name"),
                    "avatar_url": meta.get("avatar_url") or meta.get("picture"),
                }
        if uid is None:
            raise HTTPException(401, "invalid or expired credentials", headers={"WWW-Authenticate": "Bearer"})

        user = _known.get(uid)
        if user is None:
            with pool.connection() as conn, conn.cursor() as cur:
                row = provision_user(cur, uid, **profile)
            user = User(id=row["id"], handle=row["handle"], is_demo=row["id"] == settings.demo_user_id)
            _known[uid] = user
    elif settings.auth_required:
        raise HTTPException(401, "authentication required", headers={"WWW-Authenticate": "Bearer"})
    else:
        user = _demo_user()

    request.state.user = user
    return user
