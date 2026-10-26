"""Chat failover: a failing provider hands the turn to another configured one, and says so.

Pure: `_chat_once` and `available_providers` are replaced, so no network and no keys.
"""
import httpx
import pytest

from app.services import llm

ALL = [{"id": p, "label": p, "model": f"{p}-model", "configured": True} for p in ("openrouter", "gemini", "groq")]


@pytest.fixture
def providers(monkeypatch):
    monkeypatch.setattr(llm, "available_providers", lambda: ALL)
    monkeypatch.setattr(llm, "resolve_provider", lambda p: p or "groq")


def _stub(monkeypatch, failing: set[str]):
    calls: list[str] = []

    def once(history, memory_items, chosen):
        calls.append(chosen)
        if chosen in failing:
            raise llm.LLMError(f"{chosen} down")
        return "hi", chosen, f"{chosen}-model", ""

    monkeypatch.setattr(llm, "_chat_once", once)
    return calls


def test_failover_off_raises_the_original_error(providers, monkeypatch):
    calls = _stub(monkeypatch, {"gemini"})
    with pytest.raises(llm.LLMError, match="gemini down"):
        llm.chat_response([], [], "gemini")
    assert calls == ["gemini"]


def test_failover_reports_the_provider_that_actually_answered(providers, monkeypatch):
    calls = _stub(monkeypatch, {"gemini"})
    reply, provider, model, _ = llm.chat_response([], [], "gemini", failover=True)
    assert (reply, provider, model) == ("hi", "groq", "groq-model")
    assert calls == ["gemini", "groq"]


def test_failover_skips_the_failed_provider_and_unconfigured_ones(providers, monkeypatch):
    monkeypatch.setattr(llm, "available_providers", lambda: [p for p in ALL if p["id"] != "groq"])
    calls = _stub(monkeypatch, {"gemini"})
    _, provider, _, _ = llm.chat_response([], [], "gemini", failover=True)
    assert provider == "openrouter"
    assert calls == ["gemini", "openrouter"]


def test_failover_raises_the_first_error_when_everything_fails(providers, monkeypatch):
    _stub(monkeypatch, {"openrouter", "gemini", "groq"})
    with pytest.raises(llm.LLMError, match="gemini down"):
        llm.chat_response([], [], "gemini", failover=True)


def test_transport_errors_also_fail_over(providers, monkeypatch):
    calls: list[str] = []

    def once(history, memory_items, chosen):
        calls.append(chosen)
        if chosen == "gemini":
            raise httpx.ConnectTimeout("slow")
        return "ok", chosen, "m", ""

    monkeypatch.setattr(llm, "_chat_once", once)
    assert llm.chat_response([], [], "gemini", failover=True)[1] == "groq"
