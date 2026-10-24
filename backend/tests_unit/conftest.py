"""Unit tests: pure functions only, no database, no network, no model.

`tests/` needs a live Postgres + pgvector and skips itself entirely without
TEST_DATABASE_URL. Anything checkable without one belongs here, so it runs on every
machine and in every PR, not only where a database happens to be up.

Settings() requires DATABASE_URL at import, so a placeholder is set before any `app`
import. Nothing here may connect to it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("DATABASE_URL", "postgresql://unit:unit@127.0.0.1:1/never_connected")
os.environ.setdefault("ENVIRONMENT", "test")
