# Agent F: turn UI (F1, F3, F10, F12, F13, F14)

## What was built
- F1 `PrivacyBlocks.tsx`: per block, four checkboxes (chat / drafts / summaries / relevance) bound to `denied_destinations` via `api.setBlockFlows`; private toggle kept, copy says private overrides them. `MemoryTimeline.tsx`: counts and lists for `context_denied`, `superseded`, `guest_withheld`, with "withheld from this draft or reply by your <block> rule".
- F3 `Attribution.tsx`: "Measure influence" button (says k+2 regenerations, same model, quota, not causal proof). Chips read "used as context" until measured, then "changed the answer / no measurable effect / within noise / could not measure".
- F10 `DraftPanel.tsx`: overstated claims get "Where does this actually stand?" radios (in progress / planned / completed / abandoned) writing `api.edit(id, {status})`. Honest outcome: the claim is marked resolved by the user; the server has NOT re-run its check, and the copy says to ask for the draft again. Stale-only claims keep the confirm button.
- F12 `MemoryPanel.tsx`: dismissible "Since you were away" digest grouped by change with counts; stale rows have "Still true" (existing confirm). Last seen in `localStorage` (try/catch); no stored value shows nothing. Updated to now at each session start.
- F13 `page.tsx`: "Compare without memory" calls `api.regenerate(chatId, id, [], true)`; result shown in a separate block, never replaces the reply.
- F14 `page.tsx` + `MemoryPanel`: "Guest turn" checkbox sends `guest: true` (and ephemeral); disabled under the specialised workspace. Panel shows counts only while on (workspace stays mounted, clipped, `inert`).

## Decisions
- Resolve F10 client-side rather than re-running the draft: no re-run handler exists in `DraftPanel`, and a rerun would spend quota unasked. Rejected: claiming "re-checked".
- Guest panel collapse clips the workspace rather than unmounting, to keep graph state.
- Digest baseline is set at session start (first visit shows nothing by design).

## Contract requests
- None required. Question: does `regenerate` with `exclude_all` overwrite the stored assistant message? The UI assumes not (it shows the result beside the original).
- `MemoryTimeline` "linked" step still says no pass writes edges; once F4 lands that copy is stale. Left unchanged pending the F4 merge.

## Testing
`cd frontend && npm run lint && NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run build` pass. Not exercised live.

Deferred (needs backend PRs A and C merged plus a database): `docker compose up -d db`, run migrations, `make run`, `npm run dev`; then walk: flow checkboxes then a turn (timeline shows withheld), Measure influence, high-stakes draft with an overstated claim, digest (set `negotiated-memory:last-seen` in localStorage to an old ISO date and reload), Compare without memory, Guest turn.
