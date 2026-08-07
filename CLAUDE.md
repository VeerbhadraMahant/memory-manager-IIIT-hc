# Project: Negotiated AI Memory

HCI hackathon project (SIGCHI-supported). Judged on design rationale and user experience
as heavily as on implementation. Read `SYSTEM_DESIGN.md` for architecture and `PHASES.md`
for the current build phase before starting work.

## What this is
A chat interface where AI memory is actively negotiated by the user rather than accumulated
silently. Users see what is remembered, correct it, scope it to a session, and see which
memories shaped each response.

## Core concepts — use this vocabulary consistently in code and UI
- **Memory item** — a single remembered fact. Always traceable to a source message.
- **Stated vs. inferred** — user said it vs. model derived it. Inferred items default to review.
- **Block** — user-facing context grouping (work, health, family, learning). One home block per
  item; explicit sharing to reach another. Not multi-membership.
- **Assertion status** — in_progress / completed / planned / abandoned / hypothetical / third_party.
  This is the field that prevents the "claimed a paper was finished when it wasn't" failure.
- **Scope** — session or persistent. Session-scoped items must be excluded at the extraction pass,
  not merely hidden in the UI.
- **Provenance edge** — derived_from / summarized_from / contradicts / updates. Drives cascade delete.
- **Attribution** — the link between a response and the memory items that shaped it.

## Design principles — these override convenience
1. **Asymmetric error costs.** Over-restricting is an annoyance; over-sharing is a violation.
   Low-confidence classification always defaults to the *more* restrictive block.
2. **Interruption budget.** Not every memory gets a prompt. Auto-accept low-sensitivity, high-confidence
   items silently. Escalate to review only for sensitive categories and inferences. Consent fatigue
   destroys the thing consent protects.
3. **Friction proportional to irreversibility, not sensitivity.** Hard-block pre-send only for
   credentials and live secrets. Sensitive-but-legitimate disclosures (health, address) send freely,
   then get handled at the storage layer with a session-only default.
4. **Never repeat a dismissed warning** for the same category in the same session. Habituation kills
   warning systems.
5. **Phrase interventions as consequence, not caution.** "Card numbers stay in this chat's history —
   mask it?" not "Are you sure?". State what happens, offer the action, do not moralize.
6. **List view is primary and must be complete.** Keyboard-navigable, screen-reader safe, WCAG 2.2 AA.
   The graph view is supplementary and scoped only to deletion preview. Any graph capability must have
   a lossless textual equivalent.
7. **No orphaned facts.** Every memory item references a source message.

## Stack
Next.js frontend, FastAPI backend, Postgres + pgvector, OpenRouter for the LLM. Do not wrap mem0/Zep —
the provenance edges, cascade deletion, and scope enforcement are the contribution, and those libraries
abstract exactly those away.

### LLM usage rules
Chat runs on one of three providers — OpenRouter, Gemini or Groq — selectable per turn from the UI
(D32). Everything lives in `backend/app/services/llm.py` (see D29–D31 for the port off Gemini).
`LLM_BASE_URL` can point at any OpenAI-compatible gateway; no other code changes.

- **Only chat is switchable.** Extraction, embeddings and the high-stakes draft are pinned regardless
  of which model answers, and this is load-bearing rather than incidental: switching the embedder
  fragments the vector space silently (D31), and routing extraction or the draft's claim
  decomposition through a dropdown makes status classification and the overstatement check
  non-reproducible (D33). **The memory must be provider-independent** — that portability is the demo,
  so do not "simplify" by letting the selector drive the whole pipeline. Where a pinned path is
  reachable from the UI, disable the selector visibly rather than ignoring it.
- **Report which model answered, not which was requested.** An unknown or unconfigured provider
  falls back rather than failing the turn, so the response carries the provider/model that actually
  ran and the UI labels each turn with it.
- **Adding a provider** means: a key + model in `config.py`, an entry in `available_providers()`,
  and a branch in `chat_response()`. Gemini needs its own adapter (not OpenAI-compatible — system
  prompt is a separate field, `assistant` is `model`); anything OpenAI-compatible reuses
  `_openai_compatible_chat()`. Strip reasoning traces from any model that emits them.

- **Structured output, always.** Use a response schema for extraction and classification. Do not
  prompt-and-parse — schema enforcement removes a whole class of parsing bugs there is no time for.
  Strict `json_schema` mode rejects `$ref`/`$defs` and numeric bounds, both of which Pydantic emits,
  so schemas are *derived* from the Pydantic model and post-processed by `_strict_schema()` rather
  than hand-written. Do not hand-write one — the two will drift.
- **Model split.** The *stronger* model does extraction and classification, because status
  classification is the field the whole design rests on and it runs off the chat critical path. The
  *faster* model answers chat, because that is the call the user waits on. Do not collapse the two.
- **Safety filters.** The demo deliberately involves health data, personal disclosures and PII.
  Unlike Gemini, the OpenAI-compatible schema has **no per-request safety knob** — filter behaviour
  is a property of the chosen model. Re-test the real demo script after any model change. A blocked
  response mid-demo is ugly and hard to explain.
- **Rate limits.** Chat + extraction is 3+ calls per turn and `:free` slugs are limited per day.
  Extraction and classification are already batched into one call; keep them that way. Free slugs
  are also retired without notice — if chat fails, check the slug still exists before debugging.
- **Embeddings.** No free embedding model exists on OpenRouter; the configured one is paid but
  costs fractions of a cent per session. It is natively 1536-dim and truncated to 768 via the
  `dimensions` request param, so the pgvector column is unchanged.
- **Changing the embedding model requires a re-embed.** Vectors from different providers occupy
  different spaces and mixing them **fails silently** — pgvector returns the wrong memories with
  plausible distances rather than erroring. Run `backend/scripts/reembed.py` (D31).
- **Hard rule:** nothing goes to the LLM before the user has consented to send. Pre-send PII
  detection is client-side only (regex + Luhn). The model classifies only content the user already
  chose to share. This is the one place a hosted LLM tempts a shortcut that breaks the project's own
  principle, and it is checkable from the network tab.

## Honesty constraints
- Do not claim automatic re-derivation on cascade delete unless it is actually implemented.
  Tombstone + flag-for-review is the acceptable fallback; say so plainly.
- Do not overclaim the PII detector. Regex + Luhn is a fine MVP. Name it as such.
- If a phase ships partial, record what is stubbed in `PHASES.md` rather than papering over it.

## Test constraints — both of these have already cost a real bug
A check that passes for the wrong reason is worse than a missing one, because it is counted as
covered. Two ways that has happened here, both recorded (D24, D34):

- **Do not probe with words that could already be in the store.** Use an invented token seeded by
  the test itself. Otherwise a legitimate recall is indistinguishable from a leak, and a *passing*
  run means nothing either.
- **Do not let the model decide whether a guard gets exercised.** A model asked to overstate will
  often decline, so an end-to-end test of a safety check can pass without the check ever running.
  Keep such checks as pure functions and walk their failing rows directly; `--no-llm` modes exist
  for exactly this and also make the evidence demoable without spending quota.

## Working style
- Concise, copy-pasteable output. No long explanations unless asked.
- One branch per phase: `phase-1`, `phase-2`, each building on the last.
- Append to `DECISION_LOG.md` whenever a non-obvious choice is made, including rejected alternatives.
  This file is judging evidence, not bookkeeping.