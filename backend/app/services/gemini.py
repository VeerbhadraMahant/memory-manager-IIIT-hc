"""Gemini client, models, and the extraction pass.

Model split reality check (P1): CLAUDE.md specifies Flash for extraction and Pro for
chat responses. The free-tier key has **no Pro quota at all** — every Pro variant
returns 429 RESOURCE_EXHAUSTED on first call, not just under load. Chat therefore runs
on Flash too. Set GEMINI_CHAT_MODEL to a Pro model to restore the intended split if
billing is enabled; nothing else needs to change.
"""

from __future__ import annotations

import logging
import random
import time
from typing import Literal

from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from app.config import settings

log = logging.getLogger(__name__)

_client: genai.Client | None = None


def client() -> genai.Client:
    global _client
    if _client is None:
        if not settings.gemini_api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


# The demo deliberately involves health data, personal disclosures and PII. Testing
# showed the *defaults* did not block this content, but the thresholds are set
# explicitly anyway: a mid-demo block is ugly and hard to explain, and the default
# is not a contract.
SAFETY = [
    types.SafetySetting(category=c, threshold="BLOCK_NONE")
    for c in (
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
    )
]


def with_retry(fn, *, attempts: int = 4, base: float = 1.5):
    """Exponential backoff with jitter on 429/503.

    Free-tier RPM is low and a rapid live demo will hit it (CLAUDE.md, rate limits).
    Jitter matters because the chat call and the extraction call are fired close
    together and would otherwise retry in lockstep.
    """
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # google-genai raises ClientError/ServerError
            code = getattr(e, "code", None)
            retriable = code in (429, 500, 502, 503, 504) or "RESOURCE_EXHAUSTED" in str(e)
            if not retriable or i == attempts - 1:
                raise
            last = e
            delay = base * (2**i) + random.uniform(0, 0.6)
            log.warning("gemini %s, retrying in %.1fs (attempt %d/%d)", code, delay, i + 1, attempts)
            time.sleep(delay)
    raise last  # unreachable


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


# Extraction and classification are one call, not two. Free-tier RPM will not survive
# a rapid live demo at 3+ calls per turn (CLAUDE.md), and the passes share all their
# context anyway. Split them only if classification quality drops.
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

USER TURN
{turn}
"""


def extract_candidates(turn: str, block_names: list[str]) -> list[ExtractedCandidate]:
    def call():
        return client().models.generate_content(
            model=settings.gemini_extract_model,
            contents=EXTRACTION_PROMPT.format(
                blocks=", ".join(block_names), turn=turn
            ),
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=ExtractionResult,
                safety_settings=SAFETY,
                temperature=0.1,
            ),
        )

    resp = with_retry(call)
    parsed: ExtractionResult | None = resp.parsed
    return list(parsed.candidates) if parsed else []


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


def chat_response(history: list[dict], memory_items: list[dict]) -> str:
    if memory_items:
        lines = "\n".join(
            f"- [{m['status']}]{' [UNCONFIRMED FOR A WHILE]' if m.get('is_stale') else ''}"
            f" {m['content']}"
            for m in memory_items
        )
        block = f"MEMORY\n{lines}"
    else:
        block = "MEMORY\n(nothing relevant)"

    contents = [
        types.Content(
            role="model" if m["role"] == "assistant" else "user",
            parts=[types.Part(text=m["content"])],
        )
        for m in history
    ]

    def call():
        return client().models.generate_content(
            model=settings.gemini_chat_model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=CHAT_SYSTEM.format(memory_block=block),
                safety_settings=SAFETY,
                # Gemini 3.x thinks by default, which put chat responses around 20s.
                # This is the one call the user is actually waiting on. Measured on
                # gemini-3.6-flash: default 5.3s, low 3.3s, minimal 1.7s.
                # Note this is thinking_level, not thinking_budget — Gemini 3 rejects
                # the older budget parameter, and budget=0 is a 400, not a no-op.
                # Extraction keeps full thinking: it runs async, and status
                # classification is the field the whole design rests on.
                thinking_config=types.ThinkingConfig(thinking_level="minimal"),
            ),
        )

    return (with_retry(call).text or "").strip()


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
    """
    block = "\n".join(
        f"[M{i + 1}] ({m['status']}) {m['content']}" for i, m in enumerate(memories)
    ) or "(no memories available)"

    def call():
        return client().models.generate_content(
            model=settings.gemini_chat_model,
            contents=DRAFT_PROMPT.format(memory_block=block, instruction=instruction),
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=DraftResult,
                safety_settings=SAFETY,
                temperature=0.2,
            ),
        )

    return with_retry(call).parsed


# ----------------------------------------------------------------- embeddings


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch, returning exactly one unit-norm vector per input.

    Two model quirks are handled here, both found the hard way:

    1. **Only embedding-001 actually batches.** Given five inputs, gemini-embedding-2
       returns a single embedding — no error, no warning. Anything zipping inputs
       against outputs then silently drops the rest, which is how four of five
       extracted memories vanished before this check existed.
    2. **embedding-001 truncated to 768 is not unit-norm** (~0.585). pgvector's
       cosine operator tolerates that, but any dot-product or threshold comparison
       quietly misbehaves, so normalise here rather than trusting every call site.

    The length assertion is the real fix. A future model change that breaks batching
    should fail this call, not corrupt the store.
    """
    if not texts:
        return []

    def call():
        return client().models.embed_content(
            model=settings.gemini_embed_model,
            contents=texts,
            config=types.EmbedContentConfig(
                output_dimensionality=settings.embedding_dim
            ),
        )

    embeddings = with_retry(call).embeddings
    if len(embeddings) != len(texts):
        raise RuntimeError(
            f"{settings.gemini_embed_model} returned {len(embeddings)} embeddings for "
            f"{len(texts)} inputs — it does not batch. Embed one at a time or switch model."
        )

    out: list[list[float]] = []
    for e in embeddings:
        v = list(e.values)
        norm = sum(x * x for x in v) ** 0.5
        out.append([x / norm for x in v] if norm else v)
    return out
