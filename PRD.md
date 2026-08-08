# PRD — Negotiated AI Memory

HCI hackathon submission (SIGCHI-supported). Companion docs: `Project_details.md` (architecture,
build status, how to run), `DECISION_LOG.md` (47 logged decisions with rejected alternatives),
`PHASES.md` (per-phase build detail).

---

## 1. Problem

AI assistants that remember accumulate that memory silently. The user cannot see what is held,
cannot correct it, and cannot say "use this now, but do not keep it." Where controls exist at all,
they are a settings page — inspection after the fact, with no say at the moment memory forms.

Three harms follow, in increasing severity:

1. **Opacity.** The user cannot predict what the system will bring up, so cannot calibrate what to
   say next.
2. **Staleness.** Memory records a moment as if it were permanent. "Working on a paper" silently
   becomes "wrote a paper."
3. **Loss of contextual control.** A fact shared in one context resurfaces in one where it does not
   belong — a health disclosure surfacing in professional output.

**Originating incident.** A team member's memory of a research paper was recorded as complete while
it was still in progress. It propagated into an AI-generated CV and was caught in an interview. The
memory was not wrong when it was written — it went stale, and nothing forced a re-check. That is a
temporal-validity failure, not an accuracy failure, and it is the reason `assertion status`
(`in_progress` / `completed` / `planned` / `abandoned` / `hypothetical` / `third_party`) is a
first-class field on every memory item rather than a flat, timeless fact (`DECISION_LOG.md` D4).

## 2. Who this is for

No formal user survey backs this section — say so rather than dress up reasoning as findings. The
two primary personas are derived directly from the problem statement above, and the "underserved
cases" are inclusivity commitments the design must not fail, not edge cases discovered by research.

**Primary — the heavy personal user.** Uses one assistant across work and personal life. Benefits
most from memory, exposed most by it. Wants continuity without surveillance.

**Secondary — the cautious professional.** Uses AI for work output. Cares less about privacy in the
abstract than about *accuracy in artifacts* — the CV case is their nightmare, not their annoyance.
This is the persona the verification pass (§6, P6) is built for.

**Cases the design must not fail:**
- **Shared-device users** — one account, several people. Memory silently attributing one person's
  disclosure to another is a real harm, not a corner case.
- **People who have changed** — memory encodes "smoker," "job hunting," a former name. Faithful
  memory becomes a refusal to let someone move on. Deletion and rescoping are the ethical core here,
  not a convenience feature.
- **Third parties** — the user discloses a partner's diagnosis. The system now holds a fact about
  someone who never consented and cannot inspect or delete it. Named honestly as unsolved in §5.
- **Users at risk of disclosure** — anyone harmed if memory contents were seen by an abusive partner
  or unaccepting family. Requires a fast, findable purge path, not a buried setting.

## 3. Product principles

Enforced in code, not just described — see `Project_details.md` §5 for the file each one lives in.

1. Memory formation is visible *when it happens*, not auditable afterward.
2. Control without fatigue — most items pass silently; attention is spent only where it matters.
3. When uncertain, restrict. Over-restricting annoys; over-sharing violates.
4. Interventions state consequences, never scold ("card numbers stay in this chat's history — mask
   it?", not "are you sure?").
5. Nothing is remembered that cannot be traced to the message it came from.
6. Every capability is reachable without a mouse and without sight.
7. Consent that nothing reads is decoration. A choice the user makes has to change what the system
   does, and has to be revisitable, or it is a gate wearing a consent dialog.

## 4. User stories

**Onboarding and consent**
- Before my first message, I am shown what the memory layer does and where its detection is weaker
  than I might assume — including that the pre-send PII check is pattern-matching, not a classifier.
- I explicitly choose whether memory is on. Declining is one click, requires no justification, and
  immediately changes behavior: every message defaults to off-the-record.
- I can change that decision at any time from the memory panel, not just at first launch.

**Seeing**
- I can see what the system just decided to remember, inline in the conversation, without navigating
  away.
- I can tell at a glance whether something was *said by me* or *inferred about me* — never by color
  alone (fill, border style, glyph and a mono label all carry the distinction).
- When a response draws on memory, I can see which memories shaped it.

**Deciding**
- I can reject a memory before it persists, or correct its content or classification in one action,
  where it appears.
- I can write a memory myself rather than waiting for extraction to guess it.
- I can say "use this now, do not keep it" and the guarantee is structural — the extraction pass
  returns before the model is ever called on an off-the-record turn, not merely hidden in the UI.
- I can delete a memory and see what else that affects — as text, not only as a graph — before I
  confirm.

**Being protected**
- I am told when I am about to send something irreversible (a credential, a card number) before it
  leaves my device, and told plainly that the check is a local pattern match that can be wrong in
  either direction.
- I am not warned repeatedly about the same category I already dismissed this session.
- When the system generates a high-stakes artifact from memory, it asks me to confirm each
  memory-derived claim rather than asserting it.
- When something the system knows has gone stale, it says "last I knew…" rather than stating it as
  current.

## 5. Scope

**Shipped:** the negotiation loop (surface → decide → scope), classification with one-tap
correction, a coequal list/graph memory view (list is primary and complete; graph adds a full-page
exploration tab), provenance-aware deletion preview, use-time attribution with revoke-and-regenerate,
stake-proportional verification (the CV case, reproduced live), pre-send PII intervention,
three-provider chat with memory carried across a model switch, and a consent flow whose decision
actually gates extraction. Full detail and verification evidence in `Project_details.md`.

**Explicitly out of scope, named rather than hidden:**
- **Multi-user identity resolution on shared devices** — not attempted. Naming the gap is stronger
  than a token implementation that would not hold up.
- **Full third-party memory rights** — an item can be *classified* `third_party` and is chip-marked
  distinctly, but there is no mechanism for the third party to see or act on it. Surfaced, not
  resolved; there is no defensible answer in this timeline.
- **Production-grade PII detection** — regex + Luhn checksum, stated as MVP-grade in the product's
  own onboarding copy, not oversold as a classifier.
- **Automatic re-derivation after cascade delete** — tombstone + flag-for-review instead. The UI says
  this in those words rather than implying recalculation happens.
- **Provenance-edge detection** — nothing currently writes `memory_edges` (nothing notices that
  "10mg escitalopram" updates "20mg escitalopram"). The deletion-cascade *reader* is built and
  correct against an empty edge set; the *writer* is not built. Stated plainly rather than left to be
  discovered.

## 6. Success criteria

**Demo, live, in this order (full script in `MVP.md`):**
1. One turn in a plain assistant — "it just learned four things about you and you cannot see them."
2. The same turn here — a candidate card appears inline; reject one, edit one, accept one.
3. Mark something session-only, start a new session, ask about it — gone from the answer, and a
   direct database query shows it never persisted. This is the one claim proven live rather than
   asserted.
4. Ask for a CV. Memory holds "paper — in progress." The system surfaces the claim for confirmation
   instead of writing "published."
5. Point at a response, show which memories shaped it, revoke one, regenerate — "here is what it
   would have said without that."
6. Name what was not solved, in thirty seconds, before being asked.

**Verification evidence already gathered, not just claimed:**
- `leak_test_p3.py --no-llm` — session-only guarantee proven as a database query returning zero rows.
- `smoke_p2_p6.py --no-llm` — the overstatement detector walked across its full truth table as a pure
  function, including the row a real model declines to produce when asked plainly (D34) — an
  end-to-end test alone would have passed without the guard ever firing.
- A DOM-level contrast audit (not a token-pair calculator) run against the live app: 120 rendered
  text nodes across all three shell zones, zero WCAG failures, auditor validated against a known-bad
  probe before trusting a zero result.
- Real accessibility-tree inspection (not attribute presence) caught four controls whose visible text
  computed to an *empty* accessible name in Chrome despite correct DOM structure — fixed and
  re-verified (D47).
- The consent decision verified end-to-end on the network, not just in the UI: declining sends
  `session_ephemeral: true` on every turn and zero memories are extracted from it; accepting sends
  `false`.

**Anti-goals:** a memory dashboard as the headline artifact; a graph view that impresses and does
nothing (§5 — it stays coequal with, not superior to, the list); a consent prompt on every extracted
fact (defeats the interruption budget, principle 2); a consent flow whose outcome nothing reads
(principle 7 — this was a real bug, found and fixed, not a hypothetical).
