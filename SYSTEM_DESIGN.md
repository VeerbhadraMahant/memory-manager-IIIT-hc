# System Design — Negotiated AI Memory

## 1. Requirements

### Functional
- Extract memory candidates from each turn (stated facts + model inferences), kept separate.
- User reviews/accepts/edits/rejects/rescopes candidates, with low-friction auto-accept for low-risk items (interruption-budget policy — see PS2 synthesis in prior discussion).
- Session-scoped vs. persistent memory, enforced at the extraction pass, not just a UI flag.
- Classification per item: domain/block, assertion status (in-progress / completed / planned / abandoned / hypothetical / third-party), sensitivity tier, confidence.
- Primary UI: filterable list (search, bulk actions, keyboard nav, screen-reader safe).
- Secondary UI: graph view scoped specifically to deletion preview — "what else breaks if I delete this."
- Provenance edges between items, enabling cascade delete.
- Use-time attribution: every response shows which memory items shaped it; user can revoke inline and regenerate.
- Stake-proportional verification: high-stakes outputs (CV, formal doc) require confirming memory-derived claims before they land in the artifact.
- Pre-send PII detection + intervention, friction proportional to irreversibility (hard block only for credentials/live secrets; soft nudge + session-only default for sensitive-but-legitimate categories).
- Decay: in-progress items unconfirmed past a threshold trigger a lightweight re-confirmation instead of silent reuse.

### Non-functional
- Accessibility: WCAG 2.2 AA target on the primary (list) view; graph view is supplementary, never load-bearing.
- Extraction/classification must not block the chat response — async, with a visible but non-blocking indicator.
- PII pattern-detection runs client-side; raw message text should not round-trip to a server purely to check for PII.
- Every stored item must be traceable to a source message — no orphaned facts.

### Constraints
- Hackathon timeline and team size still unconfirmed on your end — the build order at the bottom assumes small team, ~24–36h. Correct me and I'll re-cut it.
- Judged on demo + design rationale, not scale. Section 4 below is intentionally thin.

## 2. High-Level Design

```
Frontend (Next.js)
 ├─ Chat UI
 ├─ Memory Panel (List | Graph[deletion preview] )
 ├─ Candidate review card (inline, per-turn)
 └─ PII intervention overlay (pre-send, client-side)

Backend (FastAPI)
 ├─ Chat orchestration        — calls LLM, injects retrieved memory as context
 ├─ Extraction service        — post-turn, pulls candidate memory items
 ├─ Classification service    — domain / status / sensitivity / confidence
 ├─ Memory store service      — CRUD, provenance graph, cascade delete
 └─ Retrieval service         — vector similarity + block/scope filter

Storage
 ├─ Postgres — users, chats, messages, memory_items, memory_edges, blocks
 └─ pgvector — embeddings on memory_items (Gemini embedding endpoint; fix dim before migrations)

LLM — Gemini API
 ├─ Flash  — extraction, classification (every turn, high volume, schema-enforced output)
 └─ Pro    — chat responses, P6 stake-proportional verification pass
```

### Data flow, one turn
1. User types → client-side PII check → if flagged, intervention shown → user proceeds/redacts/masks.
2. Message sent → retrieval service filters candidate memories by block + scope + similarity → injected as context → LLM responds.
3. Response returned **with attribution**: the specific memory_item ids that shaped it.
4. Async, post-turn: extraction pulls candidates → classification tags them → high-confidence/low-sensitivity auto-merge, everything else surfaces as a review card.
5. If a candidate relates to an existing item, a provenance edge is written.

## 3. Deep Dive

### Data model
```
users(id, ...)
chats(id, user_id, created_at)
messages(id, chat_id, role, content, created_at, session_ephemeral bool)
blocks(id, user_id, name, default_sensitivity)
memory_items(
  id, user_id, block_id, content,
  source_type      [stated | inferred],
  status           [in_progress | completed | planned | abandoned | hypothetical | third_party],
  sensitivity      [low | medium | high | special_category],
  scope            [session | persistent],
  confidence, embedding, source_message_id,
  created_at, last_confirmed_at
)
memory_edges(id, from_item_id, to_item_id, relation [derived_from | summarized_from | contradicts | updates])
attributions(id, message_id, memory_item_id)      -- use-time tracking
audit_log(id, memory_item_id, action, actor [user|system], timestamp)
```

### Key endpoints
```
POST   /chat/message                     → response + attributions[]
GET    /memory/items?block=&status=&sensitivity=&scope=
POST   /memory/items/:id/accept|reject|edit|rescope
GET    /memory/items/:id/graph           → provenance subgraph (deletion preview)
DELETE /memory/items/:id                 → cascades per policy below
POST   /memory/items/:id/confirm         → resets decay clock
```

### Cascade delete — the part someone will actually probe
On deleting item A:
1. Find every edge where A is `from_item_id`.
2. For each derived item B: if B has other independent sources, re-derive B minus A's contribution; if B has no other source, cascade-delete B too.
3. Tombstone A rather than hard-delete — keep the audit trail intact, purge on a schedule.
4. Drop A's embedding from the retrieval index.

Be honest with yourselves about step 2: live re-derivation is expensive to get right. For the hackathon, a defensible fallback is tombstone + flag-for-review rather than actual re-derivation, with the graph view showing "this will need manual review" instead of silently doing it. Claiming full automatic re-derivation and not having it is worse than admitting the limitation — a judge who asks "what happens to the summary that used this fact" will find the gap either way.

### Classification pipeline
- **Domain**: zero-shot against user-defined block names, falling back to "unclassified."
- **Status**: cheap tense/aspect heuristics first, LLM fallback for ambiguous cases (this is what would have caught the CV incident — "working on" vs "completed").
- **Sensitivity**: regex first pass for structured/special-category patterns, LLM second pass for context-dependent sensitivity (Nissenbaum-style — same fact, different context, different sensitivity).
- Confidence below threshold → default to the *more* restrictive block and force review. Never silently auto-file a low-confidence item — the error costs are asymmetric.

Gemini implementation: all three classification passes use a response schema rather than free-text
parsing. Where the item is unambiguous, batch extraction + classification into a single Flash call —
this halves per-turn request count, which matters because free-tier RPM will not survive a rapid
live demo otherwise. Exponential backoff on 429s; consider a cached path for the scripted demo run.

Safety filters need attention here specifically: the classification pass is deliberately fed health
data, personal disclosures and PII. Default thresholds may block. Test the actual demo script against
the API in the first few hours, not the last few.

### PII pre-send detection
- Client-side regex + checksum (Luhn for card numbers, format checks for common ID patterns) for structured PII.
- Small local/WASM classifier for unstructured cases (address-like, credential-like text) if time allows — regex-only is an acceptable MVP fallback, just say so rather than overclaim.
- **Gemini must not be called here.** Sending text to a hosted model to check whether it is safe to send
  defeats the purpose, and a judge opening the network tab will catch it. Pre-send is client-side only;
  Gemini enters the pipeline after the user has chosen to send.

## 4. Scale and Reliability — intentionally thin
Not a real constraint for a hackathon demo: single Postgres instance, no queue, no horizontal scaling story needed. What you'd revisit if this went past the hackathon: extraction/classification move to a real background queue (currently synchronous-ish, would bottleneck under load), and the PII detector would need proper eval/versioning instead of hand-tuned regex.

## 5. Trade-offs, made explicit
- **Sync vs. async extraction** — sync is simpler to demo end-to-end but adds latency to every single turn. Async post-turn extraction with a subtle "reviewing new memories" indicator is very likely the better call.
- **Graph view scope** — expensive to build well, easy to build badly and get flagged on accessibility. Scoping it to deletion-preview-only is a real constraint, not a cop-out.
- **Local vs. server PII detection** — local is more work but is the only credible answer to "why should I trust this." Worth the time.
- **Single-home-block vs. multi-block membership** — multi-block is more realistic but doubles complexity in deletion and provenance. Single home block + explicit share is the right call for the timeline you're on.
- **Flash vs. Pro per pass** — Flash is fast and cheap enough to run every turn without the memory loop
  feeling laggy, but classification quality is the thing the whole design rests on. If status
  classification (in_progress vs. completed) proves unreliable on Flash, move *that pass only* to Pro
  rather than the whole pipeline. It is the field the CV failure case depends on.
- **Batching extraction + classification** — one call is cheaper and survives rate limits better, two
  calls give cleaner separation and better per-pass prompts. Batch by default, split if quality drops.

## Build order (assumption: small team, ~24–36h — correct me if wrong)
P0 schema → P1 candidate surfacing (core loop, ship this even if nothing else lands) → P3 session scoping + leak-test demo → P2 classification → P6 use-time attribution + stake-proportional verification (your CV story, this is your strongest differentiator) → P4 list view complete → P7 PII pre-send → P5 graph as deletion-preview only → P8 accessibility pass.