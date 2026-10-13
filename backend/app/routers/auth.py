from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.auth import issue_session_token, verify_google_id_token
from app.config import settings
from app.db import pool
from app.ratelimit import ip_limit
from app.services.users import provision_user

router = APIRouter(prefix="/auth", tags=["auth"])


class GoogleCredential(BaseModel):
    # The ID token from Google Identity Services. Generous cap; real ones are ~1-2 KB.
    credential: str = Field(min_length=20, max_length=8192)


@router.get("/config")
def auth_config():
    """What the frontend needs to render its sign-in UI. Contains no secrets:
    the Google client id and Supabase URL are public by design."""
    return {
        "auth_required": settings.auth_required,
        "google_client_id": settings.google_client_id,
        "supabase_url": settings.supabase_url,
        "session_cookie": settings.session_cookie_name,
    }


@router.post("/google", dependencies=[Depends(ip_limit)])
def sign_in_with_google(payload: GoogleCredential, response: Response):
    claims = verify_google_id_token(payload.credential)
    sub = claims["sub"]
    with pool.connection() as conn, conn.cursor() as cur:
        # Keyed on google_sub, never email: Google documents that an email can change
        # hands, the subject identifier cannot.
        cur.execute("select id from users where google_sub = %s", (sub,))
        existing = cur.fetchone()
        row = provision_user(
            cur,
            existing["id"] if existing else uuid4(),
            email=claims.get("email"),
            name=claims.get("name"),
            avatar_url=claims.get("picture"),
            google_sub=sub,
        )
    token = issue_session_token(row["id"])
    max_age = settings.session_max_age_days * 86400
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=settings.is_production or settings.session_cookie_samesite == "none",
        samesite=settings.session_cookie_samesite,
        path="/",
    )
    return {
        "token": token,
        "expires_in": max_age,
        "user": {"id": row["id"], "email": row["email"], "name": row["name"], "avatar_url": row["avatar_url"]},
    }


@router.post("/logout")
def logout(response: Response):
    """Clears the cookie. Bearer session tokens are stateless and expire on their own;
    a client holding one should discard it."""
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"status": "signed_out"}
