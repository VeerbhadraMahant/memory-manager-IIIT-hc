# Diagram Prompts — Negotiated AI Memory

Copy-paste prompts for a diagram generator (Mermaid/Excalidraw/Napkin/Claude/GPT image).
All facts below are taken from the shipped code, not from the design doc's aspirations.
If you change the code, change the prompt.

**Global style suffix** — append to any prompt below:

> Style: flat vector, no 3D, no drop shadows, no gradients. Light background (#FAFAF8),
> ink #1A1A1A. One accent hue for the user-controlled path, one neutral grey for the
> automated path, one muted red reserved *only* for "blocked / excluded / never sent".
> Label every arrow with a verb. Sans-serif (Inter/IBM Plex Sans). 16:9. No clip art,
> no robot mascots, no brain icons. Every box must be a thing that exists in the system.

---

## 1. Technical Approach

### 1.1 The core claim — one turn, negotiated

> Draw a horizontal 5-stage pipeline showing one chat turn in a system where AI memory is
> negotiated by the user instead of accumulated silently.
>
> Stage 1 — **Pre-send (browser only)**: user types; regex + Luhn checksum scan runs
> client-side; if a credential or card number is found, an intervention offers
> mask / redact / send-as-session-only. Draw a dashed vertical boundary immediately after
> this stage labelled "network boundary — nothing has left the device yet". Annotate:
> "no LLM call here, by design — checkable in the network tab".
>
> Stage 2 — **Retrieval, filtered**: vector search over pgvector (cosine distance,
> cut at 0.65, top-8) narrowed by three hard filters applied in SQL: scope
> (session items visible only inside their own chat), review state (only accepted /
> auto-accepted items are eligible), private blocks (excluded entirely). Show three
> small filter gates in series, and a side output labelled "retrieval trace — what was
> considered and why each candidate was dropped".
>
> Stage 3 — **Answer**: selected memories are injected as context; the chat model is
> user-selectable per turn (OpenRouter / Gemini / Groq). Annotate: "the memory is
> provider-independent; only chat is switchable".
>
> Stage 4 — **Attribution, at use time**: the response is returned with the exact memory
> item IDs that shaped it, written to an attributions table. Show an inline affordance
> "revoke this memory → regenerate".
>
> Stage 5 — **Post-turn extraction (async, off the critical path)**: a background task
> extracts candidate facts and classifies them in a single schema-enforced call
> (block, assertion status, sensitivity, confidence, stated-vs-inferred). Show it
> branching *below* the main line, returning later, so it is visually clear the user
> never waits on it.
>
> Under Stage 5 draw the disposition split: **auto-accept** (stated AND low sensitivity
> AND confidence ≥ 0.85) versus **review card** (everything else). Label the auto-accept
> path "interruption budget — consent fatigue destroys the thing consent protects".

### 1.2 The disposition policy — a decision diagram

> Draw a clean decision flowchart for how one extracted memory candidate becomes a stored
> item. Inputs at the top: source_type (stated | inferred), sensitivity
> (low | medium | high | special_category), confidence (0–1), proposed block.
>
> Decisions in order:
> 1. Is the proposed block one of the user's blocks? If not → file in the fallback block
>    (the most restrictive one).
> 2. Is confidence < 0.60? → override to the fallback block regardless.
>    Annotate: "asymmetric error costs — over-restricting is an annoyance, over-sharing
>    is a violation".
> 3. Is sensitivity high or special_category? → scope = session (not blocked, not warned
>    about — simply not persisted by default; the user can promote it later with the item
>    in front of them). Otherwise scope = persistent.
> 4. Is it inferred? → pending review.
> 5. Is sensitivity anything but low? → pending review.
> 6. Is confidence < 0.85? → pending review.
> 7. Otherwise → auto-accepted, silently.
>
> Two terminal states only: **auto_accepted** and **pending review**. Beside each
> terminal, show the user-facing reason string the card displays, e.g. "inferred, not
> something you said" and "stated, low sensitivity, high confidence — accepted without
> interrupting you". Make the point visually that every prompt shown to the user carries
> its own justification.

### 1.3 Why not mem0 / Zep — a scope diagram

> Draw two stacked bars comparing "off-the-shelf memory library" against "this system".
>
> Top bar (library): a single opaque block labelled "add / search / get memory" with the
> internals greyed out and unlabelled.
>
> Bottom bar (this system): the same surface, but split into named, inspectable parts —
> provenance edges (derived_from, summarized_from, contradicts, updates), cascade
> deletion with tombstones, scope enforced in SQL at the retrieval pass, assertion status
> per item, use-time attribution, retrieval trace.
>
> Caption: "the abstracted-away parts are the contribution". Keep it sober — a comparison,
> not a marketing chart. No checkmark columns, no logos.

---

## 2. System Architecture

### 2.1 Layered architecture (the main slide diagram)

> Draw a four-layer architecture diagram, layers stacked vertically, arrows only between
> adjacent layers.
>
> **Layer 1 — Frontend (Next.js, TypeScript).** Boxes: Chat surface with per-turn provider
> selector; Memory workspace (list view — filterable, keyboard-navigable, WCAG 2.2 AA —
> marked "primary"); Graph view (provenance + deletion preview, marked "supplementary,
> never load-bearing"); Review cards; Memory timeline; Turn insight / retrieval trace
> panel; Scope panel; Privacy blocks; PII intervention overlay (marked "client-side only");
> Verified-draft panel.
>
> **Layer 2 — API (FastAPI).** Two routers. `chats`: POST /chats/{id}/message (one full
> turn), GET /candidates, POST /regenerate, POST /verified-draft, GET /scope-report,
> POST /purge-ephemeral, GET /providers. `memory`: GET/POST /items, accept, reject, PATCH
> edit, rescope, confirm, GET /graph, GET /items/{id}/graph, DELETE /items/{id} (cascade
> preview), GET /blocks, PATCH /blocks/{name}/privacy.
>
> **Layer 3 — Services.** Five boxes with one-line roles: `retrieval` (vector search +
> scope/review/private filters + trace), `extraction` (post-turn candidates),
> `classify` (block / status / sensitivity / confidence), `policy` (auto-accept vs review,
> pure functions, no I/O), `llm` (provider adapters, strict JSON schema, embeddings).
>
> **Layer 4 — Storage & models.** Postgres with pgvector: users, chats, messages, blocks,
> memory_items (embedding vector(768)), memory_edges, attributions, audit_log.
> Alongside it, an LLM box split into three *pinned* paths (extraction, embeddings,
> high-stakes draft) and one *switchable* path (chat: OpenRouter | Gemini | Groq).
> Draw the pinned paths with a small lock glyph and annotate: "switching the embedder
> fragments the vector space silently".
>
> Draw one dashed line from the frontend's PII overlay that stops at the API boundary,
> labelled "never crosses".

### 2.2 Data model / ER diagram

> Draw an entity-relationship diagram, crow's-foot notation, Postgres.
>
> - `users(id, handle, created_at)`
> - `chats(id, user_id→users, title, created_at, deleted_at)`
> - `messages(id, chat_id→chats, role, content, session_ephemeral, extraction_status, created_at)`
> - `blocks(id, user_id→users, name, default_sensitivity, restrictive_rank, is_fallback, private)`
> - `memory_items(id, user_id→users, block_id→blocks, content, source_type, status,
>   sensitivity, scope, confidence, review_state, needs_review, review_reason,
>   embedding vector(768), source_message_id→messages, session_chat_id→chats,
>   created_at, last_confirmed_at, deleted_at)`
> - `memory_edges(id, from_item_id→memory_items, to_item_id→memory_items, relation)`
> - `attributions(id, message_id→messages, memory_item_id→memory_items)`
> - `audit_log(id, memory_item_id, action, actor, detail jsonb, created_at)`
>
> Call out three constraints in the margin, each with a leader line to the field it
> concerns:
> 1. `source_message_id` is NOT NULL with ON DELETE RESTRICT — "no orphaned facts; every
>    item is traceable to a message".
> 2. `deleted_at` — "tombstone, not hard delete; the audit trail survives".
> 3. `session_chat_id` — "a session-scoped item is fenced to the chat that produced it,
>    in SQL".
>
> Show the enum value sets in small type next to their columns: source_type
> (stated | inferred); status (in_progress | completed | planned | abandoned |
> hypothetical | third_party); sensitivity (low | medium | high | special_category);
> scope (session | persistent); review_state (pending | accepted | rejected |
> auto_accepted); relation (derived_from | summarized_from | contradicts | updates).

### 2.3 Deployment / runtime view

> Draw a simple runtime topology. Browser (Next.js app) ⇄ HTTP ⇄ FastAPI process ⇄
> psycopg ⇄ Postgres 16 + pgvector. Off the FastAPI process, outbound HTTPS to an
> OpenAI-compatible LLM gateway (LLM_BASE_URL), plus Gemini via its own adapter.
>
> Show the background-task lane inside the FastAPI process (FastAPI BackgroundTasks, not a
> queue) handling extraction after the response is returned. Annotate honestly: "in-process
> background task, not a real queue — would move to a worker past hackathon scale".
>
> Mark the trust boundaries: device | server | third-party model provider. Put the PII
> scan entirely inside "device".

---

## 3. Technical Diagrams

### 3.1 Sequence diagram — one turn end to end

> Draw a UML sequence diagram. Participants, left to right: User, Browser (Next.js),
> API (FastAPI), Retrieval, Postgres+pgvector, Chat LLM, Extraction (background).
>
> 1. User → Browser: types message.
> 2. Browser → Browser: regex + Luhn PII scan (self-call). Optional alt fragment:
>    intervention shown → mask / send session-only / proceed.
> 3. Browser → API: POST /chats/{id}/message {content, session_ephemeral, provider,
>    selected_memory_ids?}.
> 4. API → Postgres: insert user message with extraction_status = pending, or *skipped*
>    if session_ephemeral. Note: "marked at write time, so a crash can never leave an
>    extractable row".
> 5. API → Retrieval → Postgres: embed query, vector search, apply scope / review_state /
>    private-block filters. Returns rows + trace.
> 6. API → Chat LLM: history + injected memory block. Returns reply + which model actually
>    ran.
> 7. API → Postgres: insert assistant message; insert attribution rows for every memory
>    used.
> 8. API → Browser: reply, used_memories, retrieval trace, provider/model that actually
>    answered, extraction_running flag.
> 9. **After the response**: API → Extraction (async): extract + classify in one
>    schema-enforced call → policy.decide() → auto-accept or write pending candidate →
>    provenance edge if it relates to an existing item.
> 10. Browser polls GET /candidates → review card appears.
>
> Draw step 9–10 clearly *after* the return arrow in step 8. Add a note: "extraction costs
> seconds; inline it and every turn feels broken".

### 3.2 Cascade deletion — state and effect

> Draw a small directed provenance graph and the effect of deleting one node.
>
> Left panel "before": node A (a stated fact) with edges to B (derived_from A only) and
> C (derived_from A *and* D). D is an independent source feeding C.
>
> Right panel "after DELETE /memory/items/A":
> - A → tombstoned (`deleted_at` set), drawn hollow with a dashed outline, not erased.
> - A's embedding removed from the retrieval index.
> - B → cascade-deleted (no remaining independent source).
> - C → **flagged for review**, drawn with a warning outline, label: "one of its sources
>   is gone — needs manual review".
>
> Add an honesty note in the corner, verbatim: "C is not automatically re-derived.
> Tombstone + flag-for-review is what is implemented; live re-derivation is not."
>
> Show that this whole diagram is what the UI renders as a *preview* before the user
> confirms — the deletion preview is the graph view's only job.

### 3.3 Retrieval trace — what the model was and wasn't allowed to see

> Draw a funnel with a rejected-items sidebar, for a single query.
>
> Top: all of the user's non-deleted memory items. Then successive narrowing stages, each
> with a count and each spilling its rejects into a labelled sidebar:
> - vector-ranked top 14 (trace width, wider than what is used, so near-misses are visible)
> - drop: cosine distance > 0.65 → "unrelated enough that injecting it dilutes attribution"
> - drop: review_state = pending → "not agreed to yet"
> - drop: scope = session belonging to a different chat → "fenced to another conversation"
> - drop: block marked private → "the model never receives this"
> - drop: embedding null → "not yet embedded"
> - keep: top 8 → injected into the prompt
>
> Mark any surviving item whose status is in_progress and whose last_confirmed_at is past
> the decay threshold with a "stale — confirm before relying on this" tag.
>
> Caption: "a claim about retrieval is only checkable if retrieval says what it did".

### 3.4 Assertion status — the failure this prevents

> Draw a two-column before/after comparison, narrative style, no icons.
>
> Left, "flat memory": user says "I'm working on a paper about X." Stored as the bare
> string "paper about X". Weeks later the model drafts a CV and writes "Published a paper
> on X." Highlight the fabricated word in red.
>
> Right, "status-typed memory": the same sentence stored as
> `content: "paper about X"`, `status: in_progress`, `source_type: stated`,
> `last_confirmed_at: <date>`. The draft pass decomposes its claims, checks each against
> the memory's status, and returns "in progress, not published" — the overstated claim is
> caught before it reaches the artifact, and the user is asked to confirm.
>
> Caption: "assertion status is the field the whole design rests on — which is why
> extraction and classification are pinned to one model and never routed through the
> chat-provider dropdown".

### 3.5 Provider routing — pinned vs. switchable

> Draw a routing diagram. One inbound turn splits into four paths.
>
> Switchable path (drawn in the accent colour, with a dropdown glyph): **chat response** →
> OpenRouter | Gemini | Groq, chosen per turn from the UI. Note: "an unknown or
> unconfigured provider falls back rather than failing the turn, and the UI labels the
> turn with the model that actually answered".
>
> Pinned paths (drawn in neutral grey, each with a lock glyph):
> - **extraction + classification** — one strict-json_schema call, stronger model, off the
>   chat critical path. "Routing this through a dropdown makes status classification
>   non-reproducible."
> - **embeddings** — 1536-dim natively, truncated to 768 via the `dimensions` param.
>   "Changing this requires a full re-embed; mixing vector spaces fails *silently* —
>   pgvector returns wrong memories with plausible distances."
> - **high-stakes verified draft** — claim decomposition and the overstatement check.
>
> Where a pinned path is reachable from the UI, show the selector rendered as visibly
> disabled rather than silently ignored.
