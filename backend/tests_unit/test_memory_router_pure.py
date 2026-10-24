from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models import FlowDestination
from app.routers.memory import dedupe_destinations, normalize_since

NOW = datetime(2026, 1, 10, 12, tzinfo=UTC)


def test_dedupe_destinations_keeps_first_seen_order():
    d = FlowDestination
    assert dedupe_destinations([d.summary, d.chat, d.summary]) == ["summary", "chat"]
    assert dedupe_destinations([]) == []


def test_normalize_since_reads_naive_as_utc_and_refuses_future():
    assert normalize_since(datetime(2026, 1, 9), NOW).tzinfo is UTC
    assert normalize_since(NOW, NOW) == NOW
    with pytest.raises(HTTPException) as e:
        normalize_since(NOW + timedelta(seconds=1), NOW)
    assert e.value.status_code == 422
