# Frontend Design Guideline — Negotiated AI Memory

Source docs: `DESIGN.md` (Synaptic Precision tokens), `Updated_Design_Brief.md` (graph experience).
This document supersedes both where they conflict. Read alongside `CLAUDE.md`, `MVP.md`, `PHASES.md`.

Stack: **Next.js + Tailwind + shadcn/ui**. Graph: **React Flow** (rationale in §3).

---

## 0. Conflicts resolved from the source docs

Do not re-litigate these while building — they are settled.

| Conflict | Resolution |
|---|---|
| `DESIGN.md` tokens say `background: #121414`; prose and brief say `#303841` | **`#303841` wins.** The token block was generator output; every component spec references Dark Slate. Regenerate tokens from §1. |
| Brief says "graph is primary, list exists for accessibility" | **Coequal.** Both views complete, both fully functional, toggle between them. Neither is a fallback. See §2. |
| `#F77A25` text on `#FAFAFA` cards | **Fails AA (~2.9:1).** Split into two orange tokens — bright for fills/glows, dark for text-on-light. See §1. |
| Stated vs. inferred carried by hue alone | **Fails WCAG 1.4.1.** Add shape redundancy. See §4.1. |
| Brief's PII action "Send Anyway" | Reword to **"Send as-is."** Consequence, not scolding (principle 5 in `CLAUDE.md`). |

---

## 1. Tokens

```css
:root {
  /* Surfaces */
  --bg:                #303841;  /* Dark Slate — app background */
  --surface:           #FAFAFA;  /* Off White — cards, panels, floating surfaces */
  --surface-raised:    #3A434E;  /* dark-mode container one step up from bg */
  --surface-sunken:    #262D35;

  /* Memory semantics */
  --stated:            #F77A25;  /* fills, node bodies, glows — NOT text on light */
  --stated-ink:        #8A3A00;  /* stated color as TEXT on --surface. verify ≥4.5:1 */
  --stated-dim:        #F77A25; /* at 12% alpha for backgrounds */
  --inferred:          #C2CEF2;  /* fills on dark */
  --inferred-ink:      #2E3F63;  /* inferred as TEXT on --surface */

  /* Text */
  --ink:               #0F1419;  /* on --surface */
  --ink-muted:         #4A5560;  /* on --surface, secondary */
  --ink-invert:        #E8EAED;  /* on --bg */
  --ink-invert-muted:  #A3ABB5;  /* on --bg, secondary — verify ≥4.5:1 */

  /* Lines */
  --outline:           rgba(250,250,250,0.14);
  --outline-strong:    rgba(250,250,250,0.28);

  /* Status */
  --danger:            #FF6B5E;
  --danger-ink:        #93000A;
}
```

**Verify every pair with a contrast checker before shipping.** The `-ink` values above are
starting points I derived by hand, not measured. Two that will definitely need checking:
`--ink-invert-muted` on `--bg`, and `--stated-ink` on `--surface`.

**Rule:** `--stated` and `--inferred` are *fill and stroke* colors. When the same semantic must
appear as text on a light card, use the `-ink` variant. Never set `#F77A25` as a text color on
`--surface`.

### Type
Already well chosen in `DESIGN.md` — keep it.

- **Hanken Grotesk** — headings. `headline-lg` 32/40 (24/32 mobile), `headline-md` 20/28.
- **Inter** — body. `body-lg` 18/28, `body-md` 16/24. Body max-width 65ch.
- **JetBrains Mono** — *system metadata only*: timestamps, confidence values, STATED/INFERRED tags,
  block names, status chips. This is a semantic rule, not decoration — mono means "the machine
  generated this," and it must never be used for conversational content.

### Spacing
4px base. Scale: 4/8/12/16/24/32/48/64. Gutter 24. Margins 16 mobile / 40 desktop.
Container max 1200. Conversation column max 800.

### Radius
Cards and inputs `0.5rem`. Buttons `rounded-lg` or pill. Nodes are circles/pills.

---

## 2. Coequal views — the architectural rule

The list is not an accessibility fallback. Both views are complete representations of the same
state, and **every action must be reachable in both.** This is a judged design decision, not a
technicality — see D6 in `DECISION_LOG.md`.

Practically, this means:

- Build one `useMemoryActions()` hook containing every operation (accept, reject, edit, rescope,
  delete, confirm, reclassify). Both views call it. No action lives inside a view component.
- View toggle is persistent, prominent, and remembered across sessions.
- If an action can only be expressed in one view, it does not ship.

**Task split, for your own sanity about what each view is *for*:**
- **List** — "what does it know about me?" Search, filter, scan, bulk act, audit.
- **Graph** — "what is connected to what?" Relationships, retrieval highlighting, deletion preview.

---

## 3. Graph implementation — React Flow

Chosen over Cytoscape (canvas-rendered — hostile to screen readers) and force-graph/D3
(non-deterministic layouts). React Flow renders real DOM nodes, which means focusable, labelable,
ARIA-addressable nodes for free. No Three.js anywhere in this project.

**Non-negotiables:**

1. **Deterministic layout.** Use `dagre` or `elk` for positioning, seeded. Same data → same
   positions, every render. Force-directed layouts move nodes on every mount, which destroys spatial
   memory *and* makes your demo unrepeatable on stage. If you want organic feel, add gentle idle
   motion on top of fixed positions — do not let physics decide placement.
2. **Every node is a `<button>` or has `role="button"`, `tabIndex`, and an `aria-label`** reading:
   content, source (stated/inferred), block, status, scope. Arrow-key navigation between connected
   nodes; Tab cycles nodes in a stable order.
3. **No hover-only actions.** The brief lists eight hover actions. Every one must also open on
   click, on Enter/Space when focused, and on tap. Hover is an accelerator, never the only path.
4. **Node cap.** Above ~150 nodes the graph is unreadable. Cluster by block beyond that, or filter.
   Do not render 500 nodes and call it a feature.
5. **Respect `prefers-reduced-motion`** — kill idle drift, radial expansion, and pulse animations;
   keep instant state changes.

---

## 4. Components

### 4.1 Memory node

Redundant encoding — color is never the only signal:

| | Stated | Inferred |
|---|---|---|
| Fill | `--stated` | `--inferred` |
| Border | 2px solid | 2px **dashed** |
| Glyph | filled dot | hollow ring |
| Mono label | `STATED` | `INFERRED` |

Persistence (from the brief, keep as-is): permanent = solid connection line + stable glow;
temporary = dashed animated connection + reduced opacity, fading toward expiry.

Status chip (`label-sm`, mono): `IN PROGRESS` / `COMPLETED` / `PLANNED` / `ABANDONED` /
`HYPOTHETICAL` / `THIRD PARTY`. **`IN PROGRESS` past its staleness threshold gets a visible
stale treatment** — this is the CV failure case made visible and it must be impossible to miss.

Touch target ≥44×44 including the reject affordance.

### 4.2 Candidate review card (P1 — the core loop)

Appears **inline in the conversation**, not in a panel. Desktop: attached below the turn.
Mobile: sticky bottom sheet.

- Shows the extracted item, its source/status/block/scope classification, and confidence.
- Actions, all at ≥44px: **Accept** (primary), **Reject**, **Edit**, **Session only**.
- Classification is inline-correctable — one tap on the block chip opens reassignment.
- On appear: focus moves to the card, `aria-live="polite"` announces "1 new memory to review."
- **Auto-accepted items do not render a card.** They log quietly with a small mono line
  ("3 remembered") that expands on click. This is the interruption budget (principle 2) — if every
  extraction shows a card, the design has failed regardless of how good the card looks.

### 4.3 PII intervention (P7)

The brief's "subtle ambient glow" is under-weighted for irreversible disclosures. Tier it:

- **Irreversible** (credentials, card numbers, gov ID): modal, focus-trapped, `--danger` 4px top
  border. Actions: **Redact & send** (primary) / **Send as-is** (ghost). Never `Cancel` only —
  the user must always be able to proceed.
- **Sensitive but legitimate** (health, address): non-modal inline strip above the composer, no
  focus steal, dismissible. Copy states consequence: "Health details will be saved to memory —
  keep to this session?"
- **Dismissed category stays silent for the rest of the session.** Habituation kills warnings.

### 4.4 Attribution + retrieval highlighting (P6)

Keep the brief's glow tiers (95–100% strong, 60–90% medium, 20–60% pulse, unrelated dim) — it's
the best idea in the source docs. Two additions:

- **Text equivalent required.** Attribution chips under each AI message, `label-sm` mono, listing
  the items used. Clicking a chip highlights the node; the chips work with no graph open at all.
- **Revoke inline** from the chip → regenerate → show the without-memory answer.

### 4.5 Deletion preview (P5)

Selecting delete highlights the dependent subgraph before confirming. Same information must render
as a plain text list ("Deleting this affects 3 memories: …"). Per `SYSTEM_DESIGN.md`, dependents are
tombstoned and flagged for review, not silently re-derived — **the UI must say that honestly.**

### 4.6 shadcn/ui usage

Use `Dialog`, `Sheet`, `Popover`, `Command`, `Badge`, `Tabs`, `Switch`, `Tooltip`, `ScrollArea`.
Override the theme via CSS vars in §1 rather than editing component internals. Do not use `Tooltip`
to carry information available nowhere else — tooltips are unreachable on touch.

---

## 5. Motion

Micro-interactions 150–300ms. Node expansion up to 400ms. Nothing over 500ms.
Animate `transform` and `opacity` only — never `width`/`height`/`top`/`left`.
Motion must communicate relationship or state change; decorative-only motion gets cut.
Full `prefers-reduced-motion` path: static positions, instant state changes, no idle drift, no pulse.

---

## 6. Accessibility floor — WCAG 2.2 AA

- Every flow in `MVP.md`'s demo script completable **keyboard-only**.
- Focus visible everywhere, 2px minimum, never removed.
- Memory state changes announced via `aria-live` regions.
- Focus management: review card takes focus on appear; modals trap and restore.
- Heading hierarchy sequential, no skips.
- Test with a real screen reader (NVDA or VoiceOver), ten minutes, before submission.
- Zoom to 200% without horizontal scroll or content loss.

---

## 7. Anti-patterns — do not ship these

- Any action available in the graph but not the list, or vice versa.
- Hover-only affordances.
- Force-directed layout that repositions on mount.
- `#F77A25` as text on `#FAFAFA`.
- Stated/inferred distinguished by color alone.
- A consent card for every extracted memory.
- Tooltips carrying unique information.
- Emoji as icons — use Lucide.
- Raw hex in components. Tokens only.
- `Cancel`-only PII dialogs that block the user from proceeding.

---

## 8. Verification pass — run twice, before submission

Load the real app at 390 / 768 / 1440. At each width:

1. Console clean, no horizontal overflow.
2. Tab through the entire memory negotiation flow. Every action reachable, focus always visible.
3. Every hover action also works on click and keyboard.
4. Toggle graph↔list — confirm no action exists in only one.
5. Contrast-check `--stated-ink`, `--inferred-ink`, `--ink-invert-muted` with a real tool.
6. `prefers-reduced-motion: reduce` — no animation survives, nothing breaks.
7. Reload the graph five times — node positions identical every time.
8. Screen reader on the review card and the PII modal.

Fix everything found, then walk again.