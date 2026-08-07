"""LLM client (OpenRouter), models, and the extraction pass.

Replaces the earlier google-genai client. OpenRouter speaks the OpenAI-compatible
REST API, so this module talks to it over plain httpx rather than pulling in the
`openai` SDK — two endpoints (chat/completions, embeddings) do not justify a
dependency, and one less install is one less thing to fail on venue wifi.

Model split (unchanged in intent from the Gemini setup, see CLAUDE.md): the
*stronger* model does extraction, because status classification is the field the
whole design rests on and it runs off the chat critical path. The *faster* model
answers chat, because that is the call the user actually waits on.

Both defaults are `:free` slugs. Free tier is rate-limited per day, and OpenRouter
retires free variants without notice — three `:free` slugs 404'd while this port was
being written. If chat starts failing, check the slug is still listed before
debugging anything here.
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from app.config import settings

log = logging.getLogger(__name__)

_client: httpx.Client | None = None

# Extraction on a large free model can genuinely take a while; the read timeout is
# the one that matters and 120s is not generous. Shared by every provider.
_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)


def client() -> httpx.Client:
    global _client
    if _client is None:
        if not settings.llm_api_key:
            raise RuntimeError("LLM_API_KEY is not set")
        _client = httpx.Client(
            base_url=settings.llm_base_url,
            headers={
                "Authorization": f"Bearer {settings.llm_api_key}",
                "Content-Type": "application/json",
                # OpenRouter attributes traffic by these; harmless if absent.
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "Negotiated AI Memory",
            },
            timeout=_TIMEOUT,
        )
    return _client


# Gemini's explicit safety thresholds have no OpenRouter equivalent — there is no
# per-request safety knob in the OpenAI-compatible schema, and per-model defaults
# vary by provider. The demo's health/PII content did not trip filters on the
# models configured here, but this is now a property of the chosen model rather
# than something the code can assert. Test the demo script after any model change.


def with_retry(fn, *, attempts: int = 4, base: float = 1.5):
    """Exponential backoff with jitter on 429/5xx.

    Free-tier daily and per-minute limits are low and a rapid live demo will hit
    them. Jitter matters because the chat call and the extraction call are fired
    close together and would otherwise retry in lockstep.
    """
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn()
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            if code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            last = e
            delay = base * (2**i) + random.uniform(0, 0.6)
            log.warning("llm %s, retrying in %.1fs (attempt %d/%d)", code, delay, i + 1, attempts)
            time.sleep(delay)
        except httpx.TransportError as e:
            if i == attempts - 1:
                raise
            last = e
            delay = base * (2**i) + random.uniform(0, 0.6)
            log.warning("llm transport error, retrying in %.1fs", delay)
            time.sleep(delay)
    raise last  # unreachable


def _post(path: str, payload: dict) -> dict:
    """POST and surface OpenRouter's error envelope as a real exception.

    OpenRouter can return HTTP 200 with an `error` body (notably for upstream
    provider failures on free models), which would otherwise be parsed as a
    successful response with no choices and fail far from the cause.
    """
    def call():
        r = client().post(path, json=payload)
        r.raise_for_status()
        return r.json()

    data = with_retry(call)
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        raise RuntimeError(f"OpenRouter error {err.get('code')}: {err.get('message')}")
    return data


# ----------------------------------------------------------------- extraction

SourceTypeL = Literal["stated", "inferred"]
StatusL = Literal[
    "in_progress", "completed", "planned", "abandoned", "hypothetical", "third_party"
]
SensitivityL = Literal["low", "medium", "high", "special_category"]


class ExtractedCandidate(BaseModel):
    content: str = Field(description="Self-contained third-person fact. No pronouns without referents.")
    evidence: str = Field(description="The exact phrase from the turn this came from.")
    source_type: SourceTypeL
    status: StatusL
    sensitivity: SensitivityL
    block: str = Field(description="One of the provided block names, or 'unclassified'.")
    confidence: float = Field(ge=0, le=1)


class ExtractionResult(BaseModel):
    candidates: list[ExtractedCandidate]


def _strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Pydantic JSON schema -> OpenAI strict-mode schema.

    Derived from the model rather than hand-written so the two cannot drift, but
    three transforms are required and each one is a real incompatibility:

    1. `$defs`/`$ref` are inlined. Strict mode rejects references.
    2. Numeric bounds are dropped. `Field(ge=0, le=1)` emits minimum/maximum,
       which strict mode rejects outright — the bound is re-checked by Pydantic
       when the response is validated, so nothing is actually lost.
    3. Every property is forced into `required` and `additionalProperties` to
       false, which strict mode demands for every object.
    """
    root = model.model_json_schema()
    defs = root.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            return walk(defs[node["$ref"].rsplit("/", 1)[-1]])
        out = {
            k: walk(v)
            for k, v in node.items()
            if k not in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "default")
        }
        if out.get("type") == "object" and "properties" in out:
            out["required"] = list(out["properties"])
            out["additionalProperties"] = False
        return out

    return walk(root)


EXTRACTION_SCHEMA = _strict_schema(ExtractionResult)


# Extraction and classification are one call, not two. Free-tier limits will not
# survive a rapid live demo at 3+ calls per turn (CLAUDE.md), and the passes share
# all their context anyway. Split them only if classification quality drops.
EXTRACTION_PROMPT = """\
Extract durable memory candidates from one turn of a user's conversation.

Extract anything that would still be worth knowing about this person in a week:
ongoing work, commitments, plans, health, relationships, living situation, stable
preferences and constraints. A substantive turn usually yields two to six candidates.

Do not extract greetings, questions, one-off requests, passing moods, or facts about
the world rather than the user. Return an empty list for small talk.

FIELDS

source_type
  stated   - the user said this
  inferred - you derived it. Anything not directly said is inferred, however obvious.

status - the temporal state of the assertion. Read tense and aspect carefully.
  in_progress   "I'm writing", "working on", "have been taking"
  completed     "I finished", "I published", "I moved"
  planned        "I'm going to", "next month I'll"
  abandoned      "I gave up on", "we dropped"
  hypothetical  "if I were to", "I might"
  third_party    the fact is about someone else, not the user
  Getting this wrong is the failure this system exists to prevent. A paper someone
  is *writing* must never be recorded as *written*. When tense is genuinely
  ambiguous, choose in_progress and lower your confidence.

sensitivity
  low               work, tools, public preferences
  medium            routines, plans, non-intimate personal details
  high              finances, relationships, location specifics
  special_category  health, sexuality, religion, politics, ethnicity, biometrics,
                    trade union membership, criminal history

block - the best fit from: {blocks}
  Use "unclassified" if the fit is not clear. Unclassified is the safe answer, not
  the lazy one.

confidence - your certainty about the whole record, not just the wording.

NEVER EXTRACT
  Card numbers, CVVs, passwords, API keys, OTPs, government ID numbers, or account
  credentials. These are not memory. Do not restate, mask, or summarise them —
  omit the fact entirely, including any partial form such as "card ending 4242".

Return JSON matching the required schema.

USER TURN
{turn}
"""


def _content(data: dict) -> str:
    """Pull message text out of a completion, tolerating empty/fenced responses."""
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"no choices in response: {str(data)[:300]}")
    msg = choices[0].get("message") or {}
    text = (msg.get("content") or "").strip()
    if text.startswith("```"):
        # Some free models fence JSON despite response_format. Strip it rather
        # than failing a demo on a formatting habit.
        body = text.split("\n", 1)[-1]
        text = body.rsplit("```", 1)[0].strip() if "```" in body else body.strip()
    return text


def extract_candidates(turn: str, block_names: list[str]) -> list[ExtractedCandidate]:
    data = _post("/chat/completions", {
        "model": settings.llm_extract_model,
        "messages": [{
            "role": "user",
            "content": EXTRACTION_PROMPT.format(blocks=", ".join(block_names), turn=turn),
        }],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "extraction", "strict": True, "schema": EXTRACTION_SCHEMA},
        },
        "temperature": 0.1,
    })

    text = _content(data)
    if not text:
        return []
    try:
        parsed = ExtractionResult.model_validate_json(text)
    except Exception:
        log.warning("extraction returned unparseable JSON: %s", text[:400])
        return []
    return list(parsed.candidates)


# ----------------------------------------------------------------- chat

CHAT_SYSTEM = """\
You are a helpful assistant with a negotiated memory of this user.

The block below contains facts the user has explicitly accepted into your memory.
Each carries a status. Honour it exactly:
  in_progress  - underway, NOT finished. Never describe it as complete or published.
  planned      - not started.
  abandoned    - dropped. Do not treat it as current.
  hypothetical - was raised as a possibility only.
  third_party  - about someone else, not the user.

If a memory is relevant, use it naturally. If none are, answer normally and do not
mention that you have a memory system. Never invent memories that are not listed.

Do not lecture the user about what they chose to share, and do not warn them about
sensitivity or privacy. Handling that is this system's job, not yours, and it happens
elsewhere — at the storage layer, with the item in front of them. A caution here is
just moralising in the middle of their sentence.

You do not control the memory and you cannot write to it. Never say you have saved,
updated, noted, remembered or forgotten anything. Nothing from this turn is stored
until the user has seen it and agreed, which happens after you reply — so claiming
otherwise is both false and a promise you are not the one keeping.

{memory_block}
"""


"""Chat providers, switchable per request.

The point of this indirection is what *doesn't* move (D32). Retrieval, extraction
and embeddings are provider-independent: the memory block below is assembled from
the store the same way whatever answers the turn, so switching from Groq to Gemini
mid-conversation carries the memory across rather than re-deriving it. A provider
here is only a way of turning (history + memory) into text.
"""

# Reasoning models emit their scratchpad inline. Qwen on Groq is the one in use,
# but the pattern is general enough to apply to any provider's output — showing a
# user the model's internal monologue is never the intent.
_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


def _strip_reasoning(text: str) -> str:
    text = _THINK_RE.sub("", text)
    # An unterminated <think> means the model hit its token ceiling mid-thought;
    # returning the scratchpad would be worse than returning nothing.
    if "<think>" in text.lower():
        text = text[: text.lower().index("<think>")]
    return text.strip()


def _openai_compatible_chat(
    *, base_url: str, api_key: str, model: str, messages: list[dict], label: str
) -> str:
    """Both OpenRouter and Groq speak this; only the host and key differ."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if "openrouter" in base_url:
        headers |= {"HTTP-Referer": "http://localhost:3000", "X-Title": "Negotiated AI Memory"}

    def call():
        with httpx.Client(base_url=base_url, headers=headers, timeout=_TIMEOUT) as c:
            r = c.post("/chat/completions", json={
                "model": model, "messages": messages, "temperature": 0.7,
            })
            r.raise_for_status()
            return r.json()

    data = with_retry(call)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(f"{label} error: {data['error'].get('message')}")
    return _strip_reasoning(_content(data))


def _gemini_chat(*, api_key: str, model: str, system: str, history: list[dict]) -> str:
    """Gemini is not OpenAI-compatible: system prompt is its own field, the
    assistant role is called 'model', and text sits under candidates[].content.parts[]."""
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": [{"text": m["content"]}],
            }
            for m in history
        ],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048},
    }

    def call():
        with httpx.Client(timeout=_TIMEOUT) as c:
            r = c.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                params={"key": api_key},
                json=body,
            )
            r.raise_for_status()
            return r.json()

    data = with_retry(call)
    if "error" in data:
        raise RuntimeError(f"Gemini error {data['error'].get('code')}: {data['error'].get('message')}")

    cands = data.get("candidates") or []
    if not cands:
        # A safety block returns no candidates at all, with the reason at top level.
        raise RuntimeError(f"Gemini returned no candidates: {str(data.get('promptFeedback'))[:200]}")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text and cands[0].get("finishReason") == "MAX_TOKENS":
        # Gemini 3.x thinks by default and can spend the whole budget doing it.
        raise RuntimeError("Gemini hit MAX_TOKENS before emitting text — raise maxOutputTokens")
    return _strip_reasoning(text)


def available_providers() -> list[dict]:
    """Providers with a key present, for the client's switcher.

    Reports configuration, not reachability — a listed provider can still fail on
    an invalid key or a retired model, and the error surfaces on the turn itself.
    """
    out = [{
        "id": "openrouter",
        "label": "OpenRouter",
        "model": settings.llm_chat_model,
        "configured": bool(settings.llm_api_key),
    }, {
        "id": "gemini",
        "label": "Gemini",
        "model": settings.gemini_chat_model,
        "configured": bool(settings.gemini_api_key),
    }, {
        "id": "groq",
        "label": "Groq",
        "model": settings.groq_chat_model,
        "configured": bool(settings.groq_api_key),
    }]
    return [p for p in out if p["configured"]]


def resolve_provider(provider: str | None) -> str:
    """Fall back to the default rather than erroring on an unknown provider.

    A chat turn is the wrong place to hard-fail on a stale dropdown value; the
    response still names which provider actually answered, so the substitution is
    visible rather than silent.
    """
    ids = {p["id"] for p in available_providers()}
    if provider in ids:
        return provider
    if provider:
        log.warning("unknown or unconfigured provider %r, falling back", provider)
    return settings.default_chat_provider if settings.default_chat_provider in ids else next(iter(ids), "openrouter")


def chat_response(
    history: list[dict], memory_items: list[dict], provider: str | None = None
) -> tuple[str, str, str]:
    """Answer one turn. Returns (reply, provider_id, model) so the caller can record
    and display which model actually spoke — necessary because `provider` is a
    request, not a guarantee (see resolve_provider)."""
    if memory_items:
        lines = "\n".join(f"- [{m['status']}] {m['content']}" for m in memory_items)
        block = f"MEMORY\n{lines}"
    else:
        block = "MEMORY\n(nothing relevant)"

    system = CHAT_SYSTEM.format(memory_block=block)
    chosen = resolve_provider(provider)

    if chosen == "gemini":
        if not settings.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        return (
            _gemini_chat(
                api_key=settings.gemini_api_key,
                model=settings.gemini_chat_model,
                system=system,
                history=history,
            ),
            "gemini",
            settings.gemini_chat_model,
        )

    # OpenAI-compatible roles are already 'user'/'assistant', so unlike Gemini
    # (which needs 'model') the history passes through unmapped.
    messages = [{"role": "system", "content": system}]
    messages += [
        {"role": "assistant" if m["role"] == "assistant" else "user", "content": m["content"]}
        for m in history
    ]

    if chosen == "groq":
        if not settings.groq_api_key:
            raise RuntimeError("GROQ_API_KEY is not set")
        return (
            _openai_compatible_chat(
                base_url=settings.groq_base_url,
                api_key=settings.groq_api_key,
                model=settings.groq_chat_model,
                messages=messages,
                label="Groq",
            ),
            "groq",
            settings.groq_chat_model,
        )

    if not settings.llm_api_key:
        raise RuntimeError("LLM_API_KEY is not set")
    return (
        _openai_compatible_chat(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_chat_model,
            messages=messages,
            label="OpenRouter",
        ),
        "openrouter",
        settings.llm_chat_model,
    )


# ----------------------------------------------------------------- embeddings


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch, returning exactly one unit-norm vector per input.

    Two invariants are enforced here, both carried over from the Gemini client
    because they protect the store rather than any particular provider:

    1. **One vector per input.** A model that silently collapses a batch to a
       single embedding would drop memories without a trace. The length check
       makes that a loud failure instead.
    2. **Unit norm.** pgvector's cosine operator tolerates unnormalised vectors,
       but any dot-product or threshold comparison quietly misbehaves, so
       normalise here rather than trusting every call site.

    `dimensions` is requested explicitly: the column is vector(768) and this
    model is natively 1536, so the truncation is load-bearing, not cosmetic.

    Note this is a *different vector space* from the Gemini embeddings used
    before the OpenRouter port. Rows embedded by the old client must be
    re-embedded (backend/scripts/reembed.py) or they will retrieve poorly
    without ever erroring.
    """
    if not texts:
        return []

    data = _post("/embeddings", {
        "model": settings.llm_embed_model,
        "input": texts,
        "dimensions": settings.embedding_dim,
    })

    items = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
    if len(items) != len(texts):
        raise RuntimeError(
            f"{settings.llm_embed_model} returned {len(items)} embeddings for "
            f"{len(texts)} inputs — it does not batch. Embed one at a time or switch model."
        )

    out: list[list[float]] = []
    for e in items:
        v = list(e["embedding"])
        if len(v) != settings.embedding_dim:
            raise RuntimeError(
                f"expected {settings.embedding_dim}-dim embedding, got {len(v)}. "
                "The pgvector column and settings.embedding_dim must agree."
            )
        norm = sum(x * x for x in v) ** 0.5
        out.append([x / norm for x in v] if norm else v)
    return out
