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
Next.js frontend, FastAPI backend, Postgres + pgvector, Gemini API for the LLM. Do not wrap mem0/Zep —
the provenance edges, cascade deletion, and scope enforcement are the contribution, and those libraries
abstract exactly those away.

### Gemini usage rules
- **Structured output, always.** Use a response schema for extraction and classification. Do not
  prompt-and-parse — schema enforcement removes a whole class of parsing bugs there is no time for.
- **Model split.** Flash for extraction and classification (runs every turn, high volume).
  Pro for chat responses and the P6 verification pass, where reasoning quality is visible.
  Do not route everything through Pro — quota burn plus latency on the loop being demoed.
- **Safety filters.** The demo deliberately involves health data, personal disclosures and PII —
  exactly what the default safety settings sometimes block. Adjust thresholds for the triggered
  categories and test the real demo script against the API early. A blocked response mid-demo is
  ugly and hard to explain.
- **Rate limits.** Chat + extraction + classification is 3+ calls per turn; free-tier RPM is low and
  rapid demo turns will hit it. Batch extraction and classification into one call where the item is
  unambiguous, add exponential backoff, cache the demo path.
- **Embeddings.** Gemini's embedding endpoint keeps everything in one SDK. Fix the vector dimension
  in the pgvector column before P0 migrations — changing it later forces a full re-embed.
- **Hard rule:** nothing goes to Gemini before the user has consented to send. Pre-send PII detection
  is client-side only (regex + Luhn). Gemini classifies only content the user already chose to share.
  This is the one place a hosted LLM tempts a shortcut that breaks the project's own principle, and
  it is checkable from the network tab.

## Honesty constraints
- Do not claim automatic re-derivation on cascade delete unless it is actually implemented.
  Tombstone + flag-for-review is the acceptable fallback; say so plainly.
- Do not overclaim the PII detector. Regex + Luhn is a fine MVP. Name it as such.
- If a phase ships partial, record what is stubbed in `PHASES.md` rather than papering over it.

## Working style
- Concise, copy-pasteable output. No long explanations unless asked.
- One branch per phase: `phase-1`, `phase-2`, each building on the last.
- Append to `DECISION_LOG.md` whenever a non-obvious choice is made, including rejected alternatives.
  This file is judging evidence, not bookkeeping.