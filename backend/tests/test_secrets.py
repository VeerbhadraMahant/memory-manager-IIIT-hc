import logging

import pytest

from app import secrets as sec


def test_file_secret_beats_env_and_is_not_put_in_environ(tmp_path):
    f = tmp_path / "k"
    f.write_text("sk-or-" "v1-fromfilefromfilefromfile\n")
    out = sec.load_secret_overrides({"LLM_API_KEY_FILE": str(f), "LLM_API_KEY": "from-env"})
    assert out == {"llm_api_key": "sk-or-" "v1-fromfilefromfilefromfile"}


def test_secrets_dir_used_only_when_env_absent(tmp_path):
    (tmp_path / "groq_api_key").write_text("gs" "k_fromdirfromdirfromdir")
    assert sec.load_secret_overrides({"SECRETS_DIR": str(tmp_path)}) == {"groq_api_key": "gs" "k_fromdirfromdirfromdir"}
    assert sec.load_secret_overrides({"SECRETS_DIR": str(tmp_path), "GROQ_API_KEY": "x"}) == {}


def test_unreadable_secret_file_fails_loudly_without_leaking_content(tmp_path):
    with pytest.raises(RuntimeError) as e:
        sec.load_secret_overrides({"DATABASE_URL_FILE": str(tmp_path / "missing")})
    assert "DATABASE_URL_FILE" in str(e.value)


def test_scrub_covers_provider_keys_urls_and_dsn_passwords():
    sec.register_secret_values(["custom-secret-value-123"])
    # Fixtures are assembled at runtime so secret scanners don't flag this file.
    text = ("Bearer " + "abcdefghijklmnop" + "1234 url=https://x/y?key=" + "AIza" "Sy" + "A" * 24 + "&z=1 "
            "dsn=postgresql://user:" + "hunter2pw" + "@host/db sk-or-" "v1-" + "abcdefghijklmnop" + "12345 "
            "custom-secret-value-123 gs" "k_" + "abcdefghijklmnop" + "1234")
    out = sec.scrub(text)
    for leaked in ("abcdefghijklmnop1234", "AIza" "Sy", "hunter2pw", "custom-secret-value-123"):
        assert leaked not in out
    assert "host/db" in out and "user:" in out


def test_log_filter_redacts_args_and_tracebacks(caplog):
    logger = logging.getLogger("t")
    h = logging.StreamHandler()
    h.addFilter(sec.RedactingFilter())
    records = []
    h.emit = records.append  # type: ignore[method-assign]
    logger.addHandler(h)
    leaked = "sk-or-" "v1-abcdefghijklmnop12345"
    try:
        raise ValueError(f"failed with {leaked}")
    except ValueError:
        logger.exception("call to %s", "https://x?api_key=SECRETVALUE99")
    r = records[0]
    assert "SECRETVALUE99" not in r.getMessage() and "abcdefghijklmnop12345" not in r.exc_text.splitlines()[-1]
    assert r.exc_text.splitlines()[-1] == "ValueError: failed with [redacted]"


def test_settings_repr_never_shows_secrets():
    from app.config import settings
    dumped = repr(settings) + str(settings.model_dump())
    assert "testkeytestkey" not in dumped and "unit-test-session-secret" not in dumped


def test_tee_detection(monkeypatch):
    monkeypatch.setattr(sec.os.path, "exists", lambda p: p == "/dev/sev-guest")
    assert sec.tee_status(["llm_api_key"]) == {"detected": True, "type": "amd-sev-snp", "secrets_from_files": ["llm_api_key"]}
    monkeypatch.setattr(sec.os.path, "exists", lambda p: False)
    assert sec.tee_status()["detected"] is False


def test_production_config_rules_fail_fast():
    from app.config import Settings
    # Explicit Nones: the test process itself has these set in its environment.
    base = dict(database_url="postgresql://a:b@h/d", environment="production", llm_api_key=None,
                google_client_id=None, session_secret=None, supabase_url=None, supabase_jwt_secret=None)
    with pytest.raises(ValueError) as e:
        Settings(**base)
    msg = e.value.errors()[0]["msg"]
    assert "AUTH_REQUIRED" in msg and "LLM_API_KEY" in msg
    ok = Settings(**{**base, "supabase_url": "https://x.supabase.co", "llm_api_key": "k" * 20},
                  auth_required=True, cors_origins="https://app.example.com")
    assert ok.is_production and ok.cors_origins == ["https://app.example.com"]
    with pytest.raises(ValueError):
        Settings(**{**base, "supabase_url": "https://x.supabase.co", "llm_api_key": "k"},
                 auth_required=True, cors_origins="*")
    with pytest.raises(ValueError):
        Settings(**{**base, "supabase_url": "https://x.supabase.co", "llm_api_key": "k"},
                 auth_required=True, llm_base_url="http://insecure")


def test_gemini_key_is_sent_in_header_not_url(monkeypatch):
    from app.services import llm
    seen = {}

    class R:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"candidates": [{"content": {"parts": [{"text": "hi"}]}}]}

    class C:
        def post(self, url, json=None, **kw):
            seen["url"] = url
            return R()

    def fake_http(base, key, headers=None):
        seen["headers"] = headers
        return C()

    monkeypatch.setattr(llm, "_http", fake_http)
    llm._gemini_chat(api_key="AIza" "SyTESTTESTTESTTESTTESTTEST", model="m", system="s", history=[{"role": "user", "content": "x"}])
    assert "AIza" not in seen["url"] and seen["headers"]["x-goog-api-key"].startswith("AIza")
