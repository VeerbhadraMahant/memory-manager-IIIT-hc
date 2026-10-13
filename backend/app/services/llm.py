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

import logging
import random
import re
import threading
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from app.config import settings
from app.secrets import scrub

log = logging.getLogger(__name__)

# Extraction on a large free model can genuinely take a while; the read timeout is
# the one that matters and 120s is not generous. Shared by every provider.
_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
_LIMITS = httpx.Limits(max_connections=40, max_keepalive_connections=20, keepalive_expiry=30)

_clients: dict[str, httpx.Client] = {}
_clients_lock = threading.Lock()


def _http(base_url: str, api_key: str | None, extra_headers: dict | None = None) -> httpx.Client:
    """One pooled, keep-alive client per provider host.

    The previous code built a new `httpx.Client` (new TLS handshake) for every chat
    call. Credentials are set once on the client and sent as headers — never in the URL,
    where HTTP libraries echo them into exception text and access logs.
    """
    key = base_url
    with _clients_lock:
        c = _clients.get(key)
        if c is None:
            headers = {"Content-Type": "application/json", **(extra_headers or {})}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            c = httpx.Client(
                base_url=base_url, headers=headers, timeout=_TIMEOUT, limits=_LIMITS,
                follow_redirects=False,  # a redirect would replay the Authorization header
            )
            _clients[key] = c
        return c


def close_clients() -> None:
    with _clients_lock:
        for c in _clients.values():
            c.close()
        _clients.clear()


def client() -> httpx.Client:
    if not settings.llm_key:
        raise RuntimeError("LLM_API_KEY is not set")
    return _http(
        settings.llm_base_url,
        settings.llm_key,
        # OpenRouter attributes traffic by these; harmless elsewhere.
        {"HTTP-Referer": settings.app_url, "X-Title": "Negotiated AI Memory"},
    )


class LLMError(RuntimeError):
    """An upstream provider failure, already safe to show a client.

    `str(e)` carries no URL, header, key or prompt text. The full detail is logged
    server-side (scrubbed) at the point of failure.
    """


def public_error(e: Exception) -> str:
    """Client-facing description of an LLM failure. Never includes upstream text."""
    if isinstance(e, LLMError):
        return str(e)
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        if code == 429:
            return "the model provider is rate-limiting us — try again shortly"
        if code in (401, 403):
            return "the model provider rejected our credentials"
        if code == 404:
            return "the configured model is no longer available"
        return f"the model provider returned HTTP {code}"
    if isinstance(e, httpx.TimeoutException):
        return "the model provider timed out"
    if isinstance(e, httpx.TransportError):
        return "could not reach the model provider"
    return "the model call failed"


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
        log.warning("openrouter error body: %s", scrub(str(err))[:300])
        raise LLMError(f"the model provider reported an error ({err.get('code')})")
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
        log.warning("no choices in response: %s", scrub(str(data))[:300])
        raise LLMError("the model returned no answer")
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

An item marked UNCONFIRMED FOR A WHILE was true when recorded but has not been checked
since. Use it, but do not state it as the current situation — say when it was last
known and invite a correction. "Last I knew you were still writing it, is that where
things are?" rather than "You are writing it."

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

# Reasoning models emit their scratchpad inline. Qwen on Groq is the one in use, but
# the pattern is general enough to apply to any provider's output.
#
# This used to be discarded. It is now *separated* instead: the reply and the
# reasoning come back as two values, so the UI can show the model's actual working
# rather than a fabricated imitation of it. Only what the model really emitted ever
# reaches the screen — a provider that emits nothing yields an empty string, and the
# UI then shows no thinking panel at all rather than inventing one.
_THINK_RE = re.compile(r"<think>(.*?)</think>\s*", re.DOTALL | re.IGNORECASE)


def _memory_block(memory_items: list[dict]) -> str:
    """Render retrieved memories for the prompt, flagging the stale ones (P6).

    Staleness is computed in SQL at retrieval, not here — this only has to make the
    distinction legible to the model, which is why it is a word in the line rather
    than a separate section. A stale item still gets used; it just gets used with
    a date attached instead of as the present tense.
    """
    if not memory_items:
        return "MEMORY\n(nothing relevant)"
    lines = "\n".join(
        f"- [{m['status']}]{' [UNCONFIRMED FOR A WHILE]' if m.get('is_stale') else ''}"
        f" {m['content']}"
        for m in memory_items
    )
    return f"MEMORY\n{lines}"


def _split_reasoning(text: str) -> tuple[str, str]:
    """Return (reply, reasoning). Reasoning is "" when the model emitted none."""
    thoughts = [m.group(1).strip() for m in _THINK_RE.finditer(text)]
    reply = _THINK_RE.sub("", text)

    # An unterminated <think> means the model hit its token ceiling mid-thought. The
    # partial scratchpad is still real and still worth showing; what must not happen
    # is it being served as the *answer*, so it moves to the reasoning side and the
    # reply keeps only what preceded it.
    lowered = reply.lower()
    if "<think>" in lowered:
        cut = lowered.index("<think>")
        thoughts.append(reply[cut + len("<think>") :].strip())
        reply = reply[:cut]

    return reply.strip(), "\n\n".join(t for t in thoughts if t)


def _strip_reasoning(text: str) -> str:
    """Reply only. For the paths where the scratchpad is noise, not content —
    extraction and the verified draft both parse structured output and must never
    have a monologue prepended to it."""
    return _split_reasoning(text)[0]


def _openai_compatible_chat(
    *, base_url: str, api_key: str, model: str, messages: list[dict], label: str
) -> tuple[str, str]:
    """Both OpenRouter and Groq speak this; only the host and key differ.

    Returns (reply, reasoning). Reasoning is "" unless the model actually emitted a
    <think> block."""
    extra = {"HTTP-Referer": settings.app_url, "X-Title": "Negotiated AI Memory"} if "openrouter" in base_url else None

    def call():
        r = _http(base_url, api_key, extra).post(
            "/chat/completions", json={"model": model, "messages": messages, "temperature": 0.7}
        )
        r.raise_for_status()
        return r.json()

    data = with_retry(call)
    if isinstance(data, dict) and data.get("error"):
        log.warning("%s error body: %s", label, scrub(str(data["error"]))[:300])
        raise LLMError(f"{label} reported an error")
    return _split_reasoning(_content(data))


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
        # Key travels in a header, not `?key=`: a query-string key is echoed into
        # httpx's HTTPStatusError text, which this app used to return to the browser.
        c = _http("https://generativelanguage.googleapis.com", None, {"x-goog-api-key": api_key})
        r = c.post(f"/v1beta/models/{model}:generateContent", json=body)
        r.raise_for_status()
        return r.json()

    data = with_retry(call)
    if "error" in data:
        log.warning("gemini error body: %s", scrub(str(data["error"]))[:300])
        raise LLMError(f"Gemini reported an error ({data['error'].get('code')})")

    cands = data.get("candidates") or []
    if not cands:
        # A safety block returns no candidates at all, with the reason at top level.
        raise LLMError("Gemini returned no candidates (the prompt may have been blocked)")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text and cands[0].get("finishReason") == "MAX_TOKENS":
        # Gemini 3.x thinks by default and can spend the whole budget doing it.
        raise LLMError("Gemini hit MAX_TOKENS before emitting text")
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
        "configured": bool(settings.llm_key),
    }, {
        "id": "gemini",
        "label": "Gemini",
        "model": settings.gemini_chat_model,
        "configured": bool(settings.gemini_key),
    }, {
        "id": "groq",
        "label": "Groq",
        "model": settings.groq_chat_model,
        "configured": bool(settings.groq_key),
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
) -> tuple[str, str, str, str]:
    """Answer one turn.

    Returns (reply, provider_id, model, reasoning). The provider and model are what
    actually ran, not what was requested (see resolve_provider). `reasoning` is the
    model's own <think> scratchpad, verbatim, and is "" for the models that emit
    none — the UI must render nothing in that case rather than substituting a
    plausible-looking summary."""
    system = CHAT_SYSTEM.format(memory_block=_memory_block(memory_items))
    chosen = resolve_provider(provider)

    if chosen == "gemini":
        if not settings.gemini_key:
            raise LLMError("Gemini is not configured")
        reply, reasoning = _split_reasoning(
            _gemini_chat(
                api_key=settings.gemini_key,
                model=settings.gemini_chat_model,
                system=system,
                history=history,
            )
        )
        return reply, "gemini", settings.gemini_chat_model, reasoning

    # OpenAI-compatible roles are already 'user'/'assistant', so unlike Gemini
    # (which needs 'model') the history passes through unmapped.
    messages = [{"role": "system", "content": system}]
    messages += [
        {"role": "assistant" if m["role"] == "assistant" else "user", "content": m["content"]}
        for m in history
    ]

    if chosen == "groq":
        if not settings.groq_key:
            raise LLMError("Groq is not configured")
        reply, reasoning = _openai_compatible_chat(
            base_url=settings.groq_base_url,
            api_key=settings.groq_key,
            model=settings.groq_chat_model,
            messages=messages,
            label="Groq",
        )
        return reply, "groq", settings.groq_chat_model, reasoning

    if not settings.llm_key:
        raise LLMError("OpenRouter is not configured")
    reply, reasoning = _openai_compatible_chat(
        base_url=settings.llm_base_url,
        api_key=settings.llm_key,
        model=settings.llm_chat_model,
        messages=messages,
        label="OpenRouter",
    )
    return reply, "openrouter", settings.llm_chat_model, reasoning


# ----------------------------------------------------------------- P6 verified draft


class DraftClaim(BaseModel):
    text: str = Field(description="The sentence or clause from the draft.")
    memory_labels: list[str] = Field(
        description="Labels like M1, M3 for the memories this rests on. Empty if none."
    )
    asserted_as: Literal[
        "completed", "in_progress", "planned", "hypothetical", "abandoned", "none"
    ] = Field(
        description="How complete this sentence makes the thing sound, judged from the "
        "sentence alone. 'published a paper' is completed; 'is writing a paper' is "
        "in_progress. Use 'none' if the sentence makes no completeness claim."
    )


class DraftResult(BaseModel):
    draft: str
    claims: list[DraftClaim]


DRAFT_SCHEMA = _strict_schema(DraftResult)


# Labels rather than UUIDs: asking a model to echo 36-character identifiers back
# accurately is a reliability problem with no upside. M1..Mn maps back in Python.
DRAFT_PROMPT = """\
Write the requested text using only the memories below. Do not invent facts about the
person. If a memory does not support something, leave it out.

Then break your own draft into claims. For each sentence that rests on a memory, give
the sentence, the labels of the memories behind it, and — reading only that sentence —
how finished it makes the thing sound.

One claim per distinct fact. If a sentence covers two things at different stages —
something underway and something merely planned — split it into two claims so each
carries its own completeness. A claim that blends stages cannot be checked.

Judge `asserted_as` from your wording, not from the memory. If you wrote "published a
paper", that is completed even if the memory says otherwise. Report what the sentence
says. A separate check compares your answer against the memory, and it only works if
you describe your own wording honestly.

MEMORIES
{memory_block}

REQUEST
{instruction}
"""


def verified_draft(instruction: str, memories: list[dict]) -> DraftResult | None:
    """Draft a high-stakes artifact and label its own claims for checking.

    The model is *not* asked whether it is overstating anything — that comparison is
    done in Python against the stored status, because a model grading its own accuracy
    is exactly the check that fails silently. All this call provides is the mapping
    from sentence to memory plus an honest description of its own phrasing.

    Pinned to the extraction model rather than the chat provider (D33). Two reasons:
    this is a structured-output call, which is what the stronger model is for (D29);
    and its output feeds the overstatement check, so letting a dropdown decide it
    would mean the P6 guarantee holds or fails depending on the UI.
    """
    block = "\n".join(
        f"[M{i + 1}] ({m['status']}) {m['content']}" for i, m in enumerate(memories)
    ) or "(no memories available)"

    data = _post("/chat/completions", {
        "model": settings.llm_extract_model,
        "messages": [{
            "role": "user",
            "content": DRAFT_PROMPT.format(memory_block=block, instruction=instruction),
        }],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "draft", "strict": True, "schema": DRAFT_SCHEMA},
        },
        "temperature": 0.2,
    })

    text = _content(data)
    if not text:
        return None
    try:
        return DraftResult.model_validate_json(text)
    except Exception:
        log.warning("verified_draft returned unparseable JSON: %s", text[:400])
        return None


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
        raise LLMError(
            f"{settings.llm_embed_model} returned {len(items)} embeddings for "
            f"{len(texts)} inputs — it does not batch. Embed one at a time or switch model."
        )

    out: list[list[float]] = []
    for e in items:
        v = list(e["embedding"])
        if len(v) != settings.embedding_dim:
            raise LLMError(
                f"expected {settings.embedding_dim}-dim embedding, got {len(v)}. "
                "The pgvector column and settings.embedding_dim must agree."
            )
        norm = sum(x * x for x in v) ** 0.5
        out.append([x / norm for x in v] if norm else v)
    return out


# ----------------------------------------------------------------- node summary


class NodeSummary(BaseModel):
    title: str = Field(description="Under eight words.")
    summary: str = Field(description="One or two sentences. Only what the notes say.")
    key_points: list[str]


SUMMARY_SCHEMA = _strict_schema(NodeSummary)

SUMMARY_PROMPT = """\
Summarise one memory and its child notes for the person who owns them.

Use only what is written below. Do not add facts, infer feelings, or fill gaps. Keep the
status exactly: if the memory says something is in progress, the summary must not
describe it as finished.

MEMORY ({status}): {content}

CHILD NOTES
{notes}
"""


def summarize_item(content: str, status: str, notes: list[str]) -> NodeSummary | None:
    """LLM summary of an item and its subnodes, or None when it cannot be produced.

    Callers fall back to a deterministic summary, so a provider outage degrades the
    graph's hover card instead of breaking it.
    """
    data = _post("/chat/completions", {
        "model": settings.llm_extract_model,
        "messages": [{"role": "user", "content": SUMMARY_PROMPT.format(
            status=status, content=content,
            notes="\n".join(f"- {n}" for n in notes) or "(none)",
        )}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "node_summary", "strict": True, "schema": SUMMARY_SCHEMA},
        },
        "temperature": 0.1,
    })
    text = _content(data)
    if not text:
        return None
    try:
        return NodeSummary.model_validate_json(text)
    except Exception:
        log.warning("node summary returned unparseable JSON")
        return None
