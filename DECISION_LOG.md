# Decision Log

Rejected alternatives are the point. Generated work never has them — this file is the clearest
evidence that the design came from people. Append as you build, in your own words. Entries written
by hand mid-build beat anything reconstructed at hour 30, and they read that way to judges too.

Format: **Decision** / Considered / Rejected because / Evidence or reasoning.

---

### D1 — Memory formation is an in-conversation event, not a settings page
**Chose:** review candidates inline, at write time.
**Considered:** a memory dashboard users visit to audit and prune.
**Rejected because:** the problem statement explicitly rejects "a one-time settings toggle buried in a
menu." A dashboard makes memory inspectable but not negotiable — the user still has no say at the
moment it forms.

### D2 — Not every memory gets a prompt (interruption budget)
**Chose:** auto-accept high-confidence, low-sensitivity items; escalate only sensitive categories and
inferences.
**Considered:** confirm every extracted item.
**Rejected because:** consent fatigue. Cookie banners are the canonical case of maximal consent
degrading into ritual clicking. Maximizing prompts would have looked more user-controlling and been
less so.
**Evidence:** Nouwens et al., "Dark Patterns after the GDPR" (CHI 2020) — VERIFY BEFORE CITING.

### D3 — Low-confidence classification defaults to the more restrictive block
**Chose:** asymmetric handling of classifier uncertainty.
**Considered:** best-guess assignment with post-hoc correction.
**Rejected because:** if a personal item is auto-routed to the professional block and surfaces in a work
email, the system causes the exact harm it advertises preventing. Over-restricting is an annoyance;
over-sharing is a violation. The costs are not symmetric, so the default should not be neutral.

### D4 — Assertion status as a first-class field
**Chose:** every item carries in_progress / completed / planned / abandoned / hypothetical / third_party.
**Considered:** storing facts as flat, timeless assertions (the standard approach).
**Rejected because:** originating incident — a team member's memory recorded a research paper as
completed when it was still in progress; it propagated into an AI-generated CV and was caught in
interview. The memory was not wrong when written. It went stale and nothing forced a re-check.
Temporal validity, not accuracy, was the failure.

### D5 — Friction proportional to irreversibility, not sensitivity
**Chose:** hard pre-send interruption only for credentials and live secrets; sensitive-but-legitimate
disclosures send freely and are handled at the storage layer with a session-only default.
**Considered:** blocking or warning on all sensitive categories before send.
**Rejected because:** blocking health or address disclosure is the paternalism the PS warns against, and
these have legitimate reasons to be in a chat. Having a memory layer means the intervention can move
off the critical path — share freely in the moment, negotiate what persists.

### D6 — List view primary, graph scoped to deletion preview
**Chose:** complete, keyboard-navigable list as the main interface; graph does one job only.
**Considered:** a force-directed memory graph as the headline artifact (Obsidian-style).
**Rejected because:** near-unusable with a screen reader, hostile to low-vision users, high cognitive
load — and empirically, graph views in tools like Obsidian are admired and rarely used for actual
navigation. Kept only where it beats a list: showing deletion consequences before committing.

### D7 — Single home block, explicit sharing; no multi-block membership
**Chose:** one home block per item.
**Considered:** items belonging to multiple blocks, which is more true to how facts actually work.
**Rejected because:** multi-membership complicates deletion and provenance, and there is always exactly
one item to delete under the single-home model. Timeline constraint made the honest call clear.

### D8 — Build the memory layer directly rather than wrapping mem0/Zep
**Chose:** own the store, provenance edges, and scope enforcement.
**Considered:** using an existing memory framework to move faster.
**Rejected because:** provenance, cascade deletion, and enforced scoping are the contribution, and those
libraries abstract exactly those away. Wrapping one would make the work invisible.

---

<!-- D9–D14 are P0 build decisions. The substance is accurate but the wording is not
     yours — rewrite them in your own voice before this file is judged. The header of
     this file is right that reconstructed entries read as reconstructed. -->

### D9 — Supabase-hosted Postgres rather than local or Docker
**Chose:** Supabase free tier, Mumbai region, pgvector 0.8.2 preinstalled.
**Considered:** local Postgres 18 (already installed and running) with pgvector built from source;
Docker Compose; dropping pgvector for a `float4[]` column with brute-force cosine in Python.
**Rejected because:** Docker was not installed. Building pgvector on Windows needs Visual Studio
Build Tools (~5GB) and an nmake build against PG18 — 1–2 hours of a 30-hour budget with real failure
modes. Brute-force cosine would genuinely have been fast enough at demo scale, but it makes the
stated stack untrue for a saving that only matters above a few thousand items.
**Residual risk, accepted:** the demo now needs network. It already did, for Gemini.
Direct connection is IPv6-only on the free tier and works on the dev machine; the session-pooler
string is the fallback if venue wifi is IPv4-only. One `.env` edit, noted in the README.

### D10 — Embedding dimension fixed at 768
**Chose:** `vector(768)`, `gemini-embedding-001` truncated via Matryoshka representation learning.
**Considered:** the model's native 3072, or the middle 1536.
**Rejected because:** 3072 quadruples index size and memory for no measurable retrieval quality gain
at a few hundred items. CLAUDE.md is right that this has to be settled before migrations — changing
it later forces a full re-embed.
**Note for implementation:** MRL truncation requires re-normalising the vector after slicing.
Skipping that step silently degrades cosine similarity rather than erroring.

### D11 — Raw SQL and a 60-line migration runner, not an ORM
**Chose:** psycopg3 with hand-written SQL; `backend/scripts/migrate.py` applies `.sql` files once
each, transactionally, tracked in a `schema_migrations` table.
**Considered:** SQLAlchemy + Alembic.
**Rejected because:** the schema is fully known up front from SYSTEM_DESIGN §3 and will barely
change. Alembic's value is managing unplanned migration over time, which is not the situation.
The setup cost is real and the pgvector column type needs hand-holding through an ORM anyway.
**Cost accepted:** no automatic rollback of a bad schema edit beyond "write a new .sql file".

### D12 — The project vocabulary is enforced as Postgres enums
**Chose:** `assertion_status`, `memory_scope`, `sensitivity_tier` etc. as DB-level enums.
**Considered:** `text` columns with CHECK constraints, or validation only in Pydantic.
**Rejected because:** CLAUDE.md asks for this vocabulary to be used consistently across code and UI.
Making the database the enforcement point means a typo fails at write time in every path, including
a manual `psql` insert during a demo. The known cost is that adding a status value later needs an
`ALTER TYPE`, which is a fair trade for a vocabulary this deliberately fixed.

### D13 — The fallback block is the *most* restrictive one, not a neutral bucket
**Chose:** an `unclassified` block at `restrictive_rank = 0`, ahead of health, with a new
`blocks.restrictive_rank` column giving a total order.
**Considered:** letting `default_sensitivity` imply restrictiveness; a neutral "inbox" block.
**Rejected because:** D3 says low-confidence classification routes to the more restrictive block, but
a sensitivity tier alone gives no ordering to route *along* — two blocks can share a tier. And a
neutral inbox quietly inverts D3: the items we understand least would sit in the least protected
place. Unclassified must be the safest place an item can land, not the most convenient.

### D14 — Session scope is anchored to a chat, not just flagged
**Chose:** `memory_items.session_chat_id`, with a CHECK constraint making it non-null exactly when
`scope = 'session'`.
**Considered:** a bare `scope` enum, as written in SYSTEM_DESIGN §3.
**Rejected because:** "session-scoped" with no referent cannot be enforced — at retrieval time there
is nothing to compare the current chat against, so the guarantee degrades into a UI filter, which is
exactly what P3 says not to do. The constraint means a session item without an anchor is
unrepresentable rather than merely discouraged.

---

<!-- D15–D21 are P1 build decisions, same caveat as D9–D14: accurate, but not in your
     voice yet. Several of these came from things that actually broke, which is worth
     keeping when you rewrite — "we found this the hard way" is the part that reads
     as real. -->

### D15 — Flash for everything, because Pro is unreachable
**Chose:** `gemini-3.5-flash` for extraction, `gemini-3.1-flash-lite` for chat.
**Considered:** the Flash/Pro split CLAUDE.md specifies, with Pro for chat and P6 verification.
**Rejected because:** not a judgement call — the free-tier key has no Pro quota whatsoever. Every Pro
variant returns 429 RESOURCE_EXHAUSTED on the first request, confirmed on retry after a delay.
**Consequence:** chat quality is lower than designed, and the P6 verification pass will run on Flash
unless billing is enabled. Both models are single env vars, so restoring the intended split is a
config change, not a rewrite. Recorded in PHASES.md rather than quietly absorbed.

### D16 — Chat and extraction deliberately run on *different* models
**Chose:** two different Flash models rather than one.
**Considered:** the obvious thing, one model for both.
**Rejected because:** the free-tier quota is `GenerateRequestsPerDayPerProjectPerModel` — 20 requests
per day, scoped *per model*. Running both passes on one model halves the number of turns the demo can
survive. Splitting them roughly doubles it for free.
**Honest about it:** this is quota arbitrage, not architecture. It is worth knowing that the choice of
which pass gets which model is still principled — extraction gets the stronger model because status
classification is the field the whole design rests on, and it runs off the critical path.

### D17 — Embeddings use gemini-embedding-001, not embedding-2 (revises D10)
**Chose:** `gemini-embedding-001`, re-normalised in application code, with a hard length assertion.
**Considered:** `gemini-embedding-2`, which returns unit-norm vectors at 768 dims and looked strictly
better.
**Rejected because:** embedding-2 does not batch. Given five inputs it returns **one** embedding —
no error, no warning. The extraction pass zipped candidates against vectors, so four of every five
extracted memories were silently dropped before ever reaching the database. It presented as "the
model under-extracts", and two prompt rewrites were spent chasing the wrong cause.
**What actually changed:** `gemini.embed()` now raises if the count of returned vectors does not match
the count of inputs, and the zip is `strict=True`. The model choice is the smaller half of this fix —
the assertion is the part that stops the next silent-truncation bug.

### D18 — Reduced thinking on chat only, full thinking on extraction
**Chose:** `thinking_level="minimal"` for chat responses; extraction keeps the default.
**Considered:** leaving defaults everywhere; disabling thinking globally.
**Rejected because:** chat is the only call the user waits on, and Gemini 3.x thinks by default —
measured 5.3s default, 3.3s low, 1.7s minimal on gemini-3.6-flash, with full turns hitting ~20s.
Extraction runs async where a slower, more careful pass costs nothing and buys classification
accuracy, which is exactly where accuracy matters.
**Note:** Gemini 3 rejects the older `thinking_budget` parameter outright, and `thinking_budget=0` is
a 400 rather than a no-op. It is `thinking_level`.

### D19 — The extractor refuses credentials rather than classifying them
**Chose:** an explicit never-extract rule covering card numbers, CVVs, passwords, API keys, OTPs and
government IDs, including partial forms like "card ending 4242".
**Considered:** extracting them and letting the sensitivity tier route them somewhere restrictive.
**Rejected because:** the first end-to-end test extracted *"User has a payment card ending in 4242"*
as a high-sensitivity memory. Tiering it would have been the system carefully filing something it
should never have written down. A payment card is not a fact about a person worth remembering, and
"masked" storage still stores it.
**Related:** this overlaps P7's pre-send detection but is not a substitute — this is server-side and
post-send. P7 is client-side and pre-send, and is still the load-bearing control.

### D20 — Session pooler over the direct connection (supersedes D9's residual risk)
**Chose:** `aws-0-ap-south-1.pooler.supabase.com:5432`, session mode.
**Considered:** keeping the direct `db.<ref>.supabase.co` host, which was working.
**Rejected because:** the risk flagged in D9 materialised during the build. The direct host is
AAAA-only, this machine's IPv6 route dropped mid-session, and Windows `getaddrinfo` then refuses to
return AAAA results at all — so Python could not resolve the host while `Resolve-DnsName` still
could, which is a genuinely confusing failure to debug under time pressure.
**Note:** session mode (5432), not transaction mode (6543) — the latter breaks psycopg's prepared
statements.

### D21 — Editing a candidate accepts it; rejecting it tombstones rather than deletes
**Chose:** a successful edit sets `review_state = 'accepted'`. Reject sets `rejected` *and*
`deleted_at`, leaving the row in place.
**Considered:** requiring an explicit accept after editing; hard-deleting rejected items.
**Rejected because:** a user who has just rewritten the text has demonstrably reviewed it — asking
them to then press "keep" is a confirmation step that carries no information, which is exactly the
consent-fatigue pattern D2 exists to avoid. And "the system proposed this and the user said no" is a
more useful record than the row never existing: it is the evidence that the negotiation happened.
Rejected items are excluded by `review_state` at retrieval, so the audit trail costs nothing at
use time.

---

<!-- D22–D24 are P3. Same caveat: rewrite in your voice. -->

### D22 — Off the record governs persistence, not the current conversation
**Chose:** an ephemeral turn is never extracted, but its text stays in the `messages` transcript and
is replayed as history within its own chat.
**Considered:** excluding ephemeral turns from the history sent to the model, so the assistant cannot
refer to them even in the same conversation.
**Rejected because:** an assistant that cannot respond to what you said thirty seconds ago is broken,
not private, and the user would simply stop using the toggle. The journalistic sense of "off the
record" is the right one: it is said, it is heard, it is not written down. The guarantee is that
nothing survives the session, and that holds — nothing was ever derived from it.
**Consequence, stated rather than hidden:** the raw text is in the database, in `messages`. That is a
different table from the memory store and a different claim, and PHASES.md says so plainly.
`POST /chats/{id}/purge-ephemeral` exists for anyone who wants the transcript cleaned too.

### D23 — The scope report names what is out of reach instead of omitting it
**Chose:** `GET /chats/{id}/scope-report` returns the *contents* of session memories confined to
other chats, and the UI shows them struck through with the session that owns them.
**Considered:** simply not returning them, which is what the retrieval path does.
**Rejected because:** "this is session-only" is otherwise an invisible promise — the user is asked to
trust a boundary they cannot see. Showing the user their own memories is not a leak; the claim being
demonstrated is that *this session cannot use them*, not that they are secret from their owner.
Naming them is what makes the boundary checkable rather than asserted.
**Also:** the report carries `items_from_ephemeral_turns_global`, a database-wide count that is
structurally 0. A number an audience can watch is better evidence than a sentence in a slide.

### D24 — The leak test probes with invented tokens, not realistic ones
**Chose:** canary strings ("Kestrel-Lane-Provisional-77", "Vaudrey-Linnet syndrome") that cannot
already exist in the store.
**Considered:** probing with the realistic demo content, which reads better.
**Rejected because:** the first version did exactly that and failed on "escitalopram" — prior smoke
runs had left *persistent* memories saying the same thing, which a new session is entitled to recall.
The test could not tell a leak from a legitimate recall. The important part is that a *passing* run
would have been equally meaningless: absence of a common word from an answer proves nothing.
**General lesson worth keeping:** a negative assertion is only evidence if the thing being looked for
could not have arrived by another route.

---

## To verify before any of this goes in a slide
Every citation below is reconstructed from memory and must be checked against the actual paper.
A fabricated reference at a SIGCHI event is unrecoverable.

- Amershi et al., "Guidelines for Human-AI Interaction" (CHI 2019) — design checklist; report which
  guidelines were met and which were deliberately violated.
- Nissenbaum, contextual integrity — privacy as appropriate flow, not secrecy. Grounds the claim that
  the same fact has different sensitivity in different contexts.
- Bellotti & Sellen (1993), design for privacy in ubiquitous computing — the feedback-and-control
  framework this problem descends from.
- Nouwens et al., "Dark Patterns after the GDPR" (CHI 2020) — consent fatigue evidence for D2.
- Browser security warning habituation literature (Akhawe & Felt; Egelman et al.) — calibration for
  never repeating a dismissed warning.
- Shneiderman's visual information-seeking mantra — overview, zoom and filter, details on demand.
- GDPR: purpose limitation, data minimisation, Art. 9 special categories, right to erasure,
  right to rectification.
