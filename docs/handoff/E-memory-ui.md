# Agent E hand-off: memory UI

Branch `phase-9/memory-ui`, base `phase-9/contract`. Lint and build pass. Nothing was run against a backend or database.

## Built

- **F4 proposed links.** `memory-store.tsx` loads `api.edgeProposals()` with the items and graph (failure yields an empty list, never a blank memory view) and exposes `proposals` plus a new `actions.decideEdge(id, state)` that refetches items, graph and proposals, then announces. `ProposalPrompt` (in `ReviewCard.tsx`) shows older/newer text and: Keep both, Replace the older one, Not related. Keep both and Not related both send `rejected`; Replace sends `confirmed`. The consequence of each is stated in a sentence under the buttons. Shown on the review card, in the expanded list row and in the graph detail panel, from one shared component, `MemoryInsights`.
- **Graph.** Rejected edges are filtered out and never drawn. Proposed edges get a dotted line (`2 6`) and the label text "(proposed)". The text equivalent (`NodeConnections`) says "(proposed)" in both visible text and the aria-label. Confirmed edges render as before.
- **DeletionPreview.** The description now itemises the cascade ("2 other memories: 1 deleted with it, 1 flagged for you to check"). Footer says only confirmed links count. The "flagged for review, not re-derived" wording is unchanged.
- **F7.** "Inferred from: ..." from incoming confirmed `derived_from` edges in the store's graph (`premisesOf` in `semantics.ts`). Inferred items only.
- **F8.** For a pending `third_party` item with a differing `abstracted`: Keep the specific version (accept), Keep the less identifying version (`editContent` with `abstracted`), Do not keep (reject).
- **F9.** `ORIGIN` map in `semantics.ts` (label, glyph name, description). `OriginTag` shows text plus icon in the review card and list rows; nothing when null. `describeMemory` now appends the origin phrase, so graph node accessible names carry it. Graph detail panel and inspector show it too.
- **F2.** List filter toggle "Accepted without asking" (`review_state === "auto_accepted"`), and a row chip with the same words.
- **F11.** "Review one at a time (N)" toggle in the list opens `ReviewQueue`: one pending item, "3 of 7" visible and announced through `MemoryLiveRegion`, Previous/Next buttons, shortcuts, and all actions through `useMemoryActions()`. The queue reuses the review card item (`ReviewItem`, a new export of the existing component), so Keep/Discard/Edit/Only this chat, reclassify chips, and F4/F7/F8 prompts all work in it.

Existing props and exports are unchanged; new props are optional (`queue` on the item, `onLight` on `MemoryInsights`). New exports from `ReviewCard.tsx`: `ReviewItem`, `OriginTag`, `MemoryInsights`.

## Deferred

- Needs backend PRs A, B1, C and a live database to see real proposals, `derived_from` edges, `abstracted` and `content_origin`. Until then the new UI renders nothing (empty proposals, null fields) and the old behaviour is intact.
- Not exercised in a browser or with a screen reader. Static checks only.
- The F8 offer is shown for pending items only (policy sends `third_party` to review). An already accepted third-party item gets no offer.
- Visual origin tag on graph nodes (see contract requests).

## Decisions and rejected alternatives

- **Shared components live in `ReviewCard.tsx`**, not a new file, to stay inside the ownership table. Rejected: a new `components/` file (cleaner, but outside the listed files).
- **Contradicts proposals get two choices** (Record the conflict / Not related), not three: "keep both" and "not related" would send the identical request, so a third button adds noise. Updates proposals get the three the brief asks for.
- **Queue shortcuts are single letters, active only while the item panel itself has focus** (`e.target === e.currentTarget`), disclosed in visible help text and `aria-keyshortcuts`, ignored with Ctrl/Alt/Meta and while editing or busy. This meets WCAG 2.1.4 by being focus-scoped. Rejected: global Alt+letter chords (collide with browser and screen-reader commands) and a page-wide listener.
- **In the queue, "Only this chat" also accepts.** `rescope` alone leaves the item pending, so the queue would show it again. Outside the queue the card behaves as before.
- **Queue is a mode of the list**, not a third tab. The existing tablist handles exactly two views with an arrow toggle; a third would change that contract and `MemoryWorkspace` stays untouched.
- **Rejected edges are filtered in `MemoryGraph`**, not in `graph-layout.ts` (not owned). Proposed state is recovered by matching `from|to|relation` against the layout edges.
- **Announcements.** After a queue action the store's own message is replaced by one combined message (result plus new position) so a screen reader user hears one thing.

## Contract requests

- `components/MemoryNode.tsx` (not in any table row): render `ORIGIN[memory.content_origin]` as a small text plus icon tag on graph nodes. Accessible names already include it via `describeMemory`.
- `lib/graph-layout.ts`: pass `state` through `PositionedEdge` so the graph does not need the key lookup in `MemoryGraph`. Optional.
- Backend (C): confirm what `PATCH /memory/edges/{id}` with `confirmed` does for a `contradicts` edge; copy says "removes nothing; both stay stored".
- `MemoryActionBar.tsx` is not owned by anyone in the table. It was left alone.

## Accessibility notes

- Queue item is one tab stop (`tabIndex=0`, labelled, described by the key help). Focus returns to it after each action or navigation, or to the empty message when the queue finishes.
- Every shortcut has a visible button. Buttons are 44px (`size="sm"` is min-h-11).
- Proposed edges: dotted line plus "(proposed)" text, never colour alone. Origin: icon plus words.
- Action results and position go through the existing polite live region.
- Suggested-link and third-party blocks are `role="group"` with labels; errors use `role="alert"`.

## How to test

Static: `cd frontend && npm run lint && NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run build`.

Live (needs A, B1, C merged): `docker compose up -d db`, run migrations, `make run`, `cd frontend && npm run dev`. Then:

1. Say "I work at Acme" then "I now work at Beta". Expect a suggested-link block on the new item (card, list row, graph panel). Try each button; Replace should stop the older fact appearing in retrieval.
2. Say something that yields an inference with premises; expect "Inferred from:".
3. Mention a friend's health detail; expect the less identifying choice on the card.
4. List: toggle "Accepted without asking".
5. List: "Review one at a time". Tab to the item, use Down, K, D, E, T. With a screen reader, check "3 of 7" is announced.
6. Graph, Provenance mode: proposed links dotted and labelled "(proposed)"; rejected ones absent.
7. Delete an item that has dependents; check the itemised sentence.
